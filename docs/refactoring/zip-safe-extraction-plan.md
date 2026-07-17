# Plan: consolidate ZIP extraction guard

Status: **PLAN MODE — no production code or tests are changed by this document.**

## 1. Summary

PR-2 is a deliberately small, behavior-preserving refactor. It will consolidate the
two currently duplicated ZIP extraction guards into one pure archive module:

```text
src/main/archive/zip-extraction-guard.ts
```

The module will own the structural `ZipEntryLike` contract, per-extraction mutable
accounting, ZIP-bomb limits enforcement, directory-entry skipping, and the exact
three extraction-limit error strings. It will import the three canonical limits from
`archive/zip-validation.ts`; it will not duplicate numeric values.

Both existing `extract-zip` consumers will call a fresh guard factory:

- `src/main/index.ts` for VST3 installation extraction;
- `src/main/antivirus.ts` for untrusted archive anti-spoofing extraction.

This PR does not create a custom extractor and does not change path, symlink,
staging, cleanup, copy, hash, trust, IPC, or VirusTotal behavior.

## 2. Baseline and branch

- Working branch: `refactor/zip-safe-extraction`.
- Baseline commit: `d545bcb34bde55cbdcb75283abbb362b370f4304`.
- Baseline is the merged ZIP-validation refactor and contains:
  - `src/main/archive/archive-types.ts`;
  - `src/main/archive/zip-validation.ts`;
  - ZIP characterization/regression tests and a test-only fixture builder.
- Before implementation, require a clean worktree and confirm the branch starts from
  this baseline (or its approved successor).

## 3. Current duplication

`src/main/index.ts` currently defines:

- `interface ZipEntryLike`;
- `makeZipExtractionGuard()`;
- closure-scoped `fileCount` and `totalBytes`;
- checks against the `MAX_*` imports from `archive/zip-validation.ts`.

It passes `makeZipExtractionGuard()` to `extractZip()` in `installVst3FromZip()`.

`src/main/antivirus.ts` independently defines:

- local `MAX_EXTRACTED_FILES`, `MAX_SINGLE_FILE_BYTES`, and
  `MAX_TOTAL_UNCOMPRESSED_BYTES` literals;
- its own `interface ZipEntryLike`;
- `makeExtractionGuard()` with equivalent accounting and exact same errors.

Its local `MAX_*` declarations have no usage outside `makeExtractionGuard()`.
`runSecurityPipeline()` passes `makeExtractionGuard()` to `extractZip()`.

The two implementations use the same limits and behavior today, but the duplicate
numeric constants can drift. PR-2 removes this policy duplication while preserving
both consumers' extraction flow.

## 4. Exact scope

The intended implementation file list is complete:

| File | Change |
|---|---|
| `docs/refactoring/zip-safe-extraction-plan.md` | This plan. |
| `src/main/archive/zip-extraction-guard.ts` | Add pure shared entry type and guard factory. |
| `src/main/index.ts` | Remove local type/factory and import/use shared factory. |
| `src/main/antivirus.ts` | Remove local limits/type/factory and import/use shared factory. |
| `test/unit/archive/zip-extraction-guard.test.ts` | Add Node-only characterization/regression tests. |

No changes are planned for `package.json`, lockfiles, dependencies, TypeScript/Vitest/
ESLint configuration, `zip-validation.ts`, `archive-types.ts`, Electron IPC, renderer,
downloader, Supabase, VirusTotal, or `444.bat`.

### Symbols moved from `index.ts`

- `ZipEntryLike`;
- `makeZipExtractionGuard`.

### Duplicates removed from `antivirus.ts`

- local `MAX_EXTRACTED_FILES`;
- local `MAX_SINGLE_FILE_BYTES`;
- local `MAX_TOTAL_UNCOMPRESSED_BYTES`;
- local `ZipEntryLike`;
- local `makeExtractionGuard`.

Do not retain a `makeExtractionGuard` alias: it has one production call site and no
public/module consumer, so importing the canonical `makeZipExtractionGuard` directly
is the smaller, clearer diff.

## 5. Out of scope

PR-2 must not:

- add application-owned ZIP filename validation;
- change `yauzl` or `extract-zip` validation behavior;
- reject symlink entries or alter symlink handling;
- normalize or validate traversal, absolute, drive, UNC, or mixed-separator paths;
- replace `extract-zip` or move actual extraction into a wrapper;
- move `installVst3FromZip`;
- change staging or temporary directory creation, cleanup, copy logic, overwrite
  behavior, VST3 discovery, or error mapping;
- change hash verification or the remaining TOCTOU window;
- change quarantine, VirusTotal, catalog/community trust, IPC trusted-sender checks,
  preload, renderer, or automatic execution behavior.

## 6. Dependency graph

Target dependency direction:

```text
src/main/index.ts ─────────┐
                           ├──> archive/zip-extraction-guard.ts
src/main/antivirus.ts ─────┘               │
                                           └──> archive/zip-validation.ts
```

`zip-extraction-guard.ts` must stay pure and Node-testable. It may import only the
three `MAX_*` constants from `./zip-validation` for this scope. In particular it must
not import Electron, `app`, `BrowserWindow`, `ipcMain`, Supabase, `antivirus.ts`,
`index.ts`, preload, renderer, or `extract-zip`.

This avoids an `index.ts ↔ antivirus.ts` cycle and preserves the pure archive test
boundary established by PR-1.

## 7. Public API

Create this exact API in `src/main/archive/zip-extraction-guard.ts`:

```ts
export interface ZipEntryLike {
  fileName: string
  uncompressedSize: number
}

export function makeZipExtractionGuard(): (entry: ZipEntryLike) => void
```

`extract-zip@2.0.1` declares its callback as:

```ts
onEntry?: (entry: yauzl.Entry, zipfile: yauzl.ZipFile) => void
```

`yauzl.Entry` structurally has the two fields required by `ZipEntryLike`. A unary
callback accepting this narrower structural parameter is compatible with the
two-argument callback: JavaScript supplies the unused `zipfile` argument and the
guard does not need it. Do not import the package's `Entry` type, because the guard
requires only this stable minimal contract and should not be coupled to extractor
types.

## 8. Behavior invariants

The shared implementation must preserve both current guards exactly:

1. Each `makeZipExtractionGuard()` call creates independent closure state:
   `fileCount = 0`, `totalBytes = 0`.
2. A directory is exactly `entry.fileName.endsWith('/')`.
3. A directory returns immediately and changes neither counter.
4. For a non-directory entry, in this exact order:
   1. increment `fileCount`;
   2. throw if `fileCount > MAX_EXTRACTED_FILES`;
   3. calculate `const size = Number(entry.uncompressedSize) || 0`;
   4. throw if `size > MAX_SINGLE_FILE_BYTES`;
   5. add `size` to `totalBytes`;
   6. throw if `totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES`.
5. `=== MAX_*` is allowed; only `> MAX_*` rejects.
6. The guard throws synchronously. `extract-zip` invokes `onEntry` during extraction;
   its existing catch path closes the ZIP and rejects extraction on that throw.
7. A guard must be created at each call site as `makeZipExtractionGuard()` inside the
   extraction options. It must never be instantiated once at module scope or shared
   by concurrent extraction operations.
8. No validation is added for unusual runtime values in this refactor. The existing
   `Number(...) || 0` semantics remain authoritative.

The canonical limits must only be imported from `archive/zip-validation.ts`:

- `MAX_EXTRACTED_FILES`;
- `MAX_SINGLE_FILE_BYTES`;
- `MAX_TOTAL_UNCOMPRESSED_BYTES`.

## 9. Error strings

The current strings in `index.ts` and `antivirus.ts` are identical. Transfer them
without edits.

| Condition | `index.ts` | `antivirus.ts` | Shared final text |
|---|---|---|---|
| File count exceeds maximum | `В архиве слишком много файлов.` | `В архиве слишком много файлов.` | `В архиве слишком много файлов.` |
| One declared file size exceeds maximum | `Файл внутри архива слишком большой.` | `Файл внутри архива слишком большой.` | `Файл внутри архива слишком большой.` |
| Declared aggregate size exceeds maximum | `Содержимое архива превышает допустимый размер.` | `Содержимое архива превышает допустимый размер.` | `Содержимое архива превышает допустимый размер.` |

If this comparison changes before implementation, stop and record a design decision;
do not choose an error text implicitly.

## 10. Step-by-step implementation

1. Reconfirm branch, baseline, clean worktree, and that no unrelated changes exist.
2. Inspect current `ZipEntryLike`, both guard factories, all local `MAX_*` usages in
   `antivirus.ts`, and the installed `extract-zip` type declaration.
3. Add `archive/zip-extraction-guard.ts` with the API in section 7. Import only the
   three canonical limits from `./zip-validation`; copy the current `index.ts` guard
   body without changing logic, check order, numeric coercion, or error strings.
4. In `index.ts`, replace the `MAX_*` imports and local `ZipEntryLike`/
   `makeZipExtractionGuard` block with an import of `makeZipExtractionGuard` from the
   new module. Leave `extractZip`, `installVst3FromZip`, and all orchestration intact.
5. In `antivirus.ts`, add the same import. Delete only its local `MAX_*` constants,
   local `ZipEntryLike`, and local `makeExtractionGuard`; change its sole call site
   to `makeZipExtractionGuard()`.
6. Add the pure Node unit tests described in section 11. They must import only archive
   modules, never Electron, `index.ts`, `antivirus.ts`, or `extract-zip`.
7. Search after the edit to confirm one definition of `ZipEntryLike`, one definition
   of `makeZipExtractionGuard`, and one definition each of the three `MAX_*` values.
8. Run the verification commands in section 12. Review the staged/untracked diff for
   scope, exact errors, and no generated artifacts before any later commit stage.

## 11. Test matrix

Create `test/unit/archive/zip-extraction-guard.test.ts`. Use direct plain objects
matching `ZipEntryLike`; no ZIP archive, filesystem, Electron, mock extractor, timing,
or network is needed.

| # | Category | Case | Expected assertion |
|---:|---|---|---|
| 1 | Basic | One normal file | no throw. |
| 2 | Basic | One directory entry | no throw and no counters consumed. |
| 3 | Basic | More than maximum directories followed by one file | file remains accepted; directories affect no limits. |
| 4 | State | Two factory results | their counters are independent. |
| 5 | Sync lifecycle | Exceeding a limit | `expect(() => guard(entry)).toThrow(...)`, proving synchronous throw. |
| 6 | File count | Exactly `MAX_EXTRACTED_FILES` files | no throw. |
| 7 | File count | `MAX_EXTRACTED_FILES + 1` files | full count error string. |
| 8 | File count | Directories around count boundary | directories do not contribute. |
| 9 | Per-file size | Exactly `MAX_SINGLE_FILE_BYTES` | no throw. |
| 10 | Per-file size | `MAX_SINGLE_FILE_BYTES + 1` | full per-file error string. |
| 11 | Total size | Entries totalling exactly `MAX_TOTAL_UNCOMPRESSED_BYTES` | no throw. |
| 12 | Total size | Entries totalling `MAX_TOTAL_UNCOMPRESSED_BYTES + 1` | full total error string. |
| 13 | Total size | Directories around total boundary | directories do not contribute. |
| 14 | Ordering | One entry exceeds per-file and would also exceed total | per-file error occurs first. |
| 15 | Ordering | Count already exceeds before an oversized entry is evaluated | count error occurs first. |
| 16 | Post-failure characterization | Invoke same guard after a thrown count/size error | document and assert current closure state; no reset behavior is introduced. |
| 17 | Unusual value | `uncompressedSize = 0` | characterize `Number(value) || 0` result. |
| 18 | Unusual value | negative `uncompressedSize` | characterize current arithmetic/counter behavior without changing it. |
| 19 | Unusual value | `NaN` | characterize coercion to zero. |
| 20 | Unusual value | `Infinity` | characterize current per-file rejection. |
| 21 | Unusual value | absent/non-numeric value through a runtime cast | characterize current coercion to zero. |

The unusual-value tests are characterization only. If negative or coerced values are
considered unsafe, they become a separately approved hardening task; this PR must not
silently validate, clamp, reset, or reject new values.

Existing `test/unit/archive/zip-validation.test.ts` remains unchanged and continues to
cover matching declared-size/count behavior in central-directory inspection.

## 12. Verification commands

After implementation, run:

```text
npx vitest run test/unit/archive
npm run lint
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run check
```

Also perform source checks to establish integration invariants:

- `ZipEntryLike` is defined only in `archive/zip-extraction-guard.ts`.
- `makeZipExtractionGuard` is defined only in `archive/zip-extraction-guard.ts`.
- Numeric definitions for all three `MAX_*` limits exist only in
  `archive/zip-validation.ts`.
- Both `index.ts` and `antivirus.ts` import and call the canonical factory.
- Each `extractZip` call site has its own `makeZipExtractionGuard()` factory call.
- No `makeExtractionGuard` alias remains.
- No cycle or Electron/application import enters the archive guard module.
- `git diff --check` passes and no generated coverage/build artifacts are included.

## 13. Risks and rollback

| Risk | Prevention / verification |
|---|---|
| Old guard accidentally remains | Repository search confirms one factory definition and no `makeExtractionGuard`. |
| Error text drift | Copy exact strings; unit tests compare full strings. |
| Check order changes | Keep transferred body order; explicit ordering tests. |
| Shared mutable state across extraction | Factory creates closure state per invocation; test independent factories; verify each call site invokes it inline. |
| Factory created once at module scope | No module-level guard variable; source review and two-factory test. |
| Archive module imports application code | Restrict imports to `./zip-validation`; run typecheck and import review. |
| Circular dependency | Dependency direction is consumers → guard → validation only. |
| `extract-zip` callback incompatibility | Installed declaration confirms `(entry: yauzl.Entry, zipfile: yauzl.ZipFile) => void`; structural two-field parameter is sufficient. |
| Unrelated antivirus cleanup changes | Do not modify `runSecurityPipeline` staging, `try/catch/finally`, or `rmSync` cleanup. |
| Refactor mixes in path/symlink hardening | Keep all path/symlink decisions explicitly out of scope. |

Rollback is a single-PR revert: remove the new module/test, restore the two local guard
implementations and antivirus local constants, and restore the two consumer imports.
No data migration, dependency change, or persistent state is involved.

## 14. Definition of Done

- [ ] The five files in section 4 are the only intentional PR-2 changes.
- [ ] Shared module exposes exactly `ZipEntryLike` and `makeZipExtractionGuard`.
- [ ] Both consumers use the same imported factory and instantiate it separately.
- [ ] `index.ts` no longer defines local guard/type or imports extraction `MAX_*`.
- [ ] `antivirus.ts` no longer defines local guard/type/local extraction `MAX_*` values.
- [ ] Canonical numeric limits remain only in `archive/zip-validation.ts`.
- [ ] Exact error messages, numeric coercion, directory rule, boundaries, and check
  order are unchanged.
- [ ] New tests are pure Node tests and cover the matrix in section 11.
- [ ] All commands in section 12 pass without configuration/threshold changes.
- [ ] No extraction, staging, cleanup, path, symlink, trust, hash, IPC, or UI behavior
  is changed.
- [ ] `444.bat` is untouched.

## 15. Follow-up hardening

The following work is intentionally not a vulnerability claim and not part of PR-2.
It needs separate threat-model, compatibility, and adversarial integration review:

1. Define and enforce an application-owned policy that rejects symlink ZIP entries
   before they are materialized in the temporary extraction tree.
2. Define an application-owned ZIP filename policy rather than relying only on
   `yauzl`/`extract-zip` defaults.
3. Add real extraction tests for `../`, nested traversal, POSIX absolute paths,
   Windows drive paths, UNC paths, mixed separators, `C:relative`, and symlink entries.
4. Trace and decide the exact `extract-zip` ordering before/after `onEntry`, including
   whether parent directories can be materialized before a policy callback rejects an
   entry.
5. Add integration tests for partial extraction and cleanup after each extraction
   failure stage.
6. Analyze the residual scan-hash-to-open TOCTOU interval and decide whether a
   descriptor-based or atomic staging design is warranted.
7. Decide compatibility policy for existing archives, especially archives containing
   symlinks or platform-specific names, before changing acceptance behavior.
