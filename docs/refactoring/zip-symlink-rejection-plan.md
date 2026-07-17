# PR-3 Plan: Reject ZIP Symlink Entries Before Extraction

Status: **PLAN READY**

## 1. Summary

PR-3 is a minimal security hardening change for both ZIP extraction consumers.
It extends the existing shared `makeZipExtractionGuard()` so that every
non-directory entry that `extract-zip@2.0.1` would materialize as a symbolic
link is rejected synchronously before `fs.symlink` is reached.

The same guard is already instantiated separately for:

- VST3 installation extraction in `src/main/index.ts`;
- antivirus extraction in `src/main/antivirus.ts`.

No call-site change is required. The existing file-count, single-file-size,
total-uncompressed-size, directory, cleanup, quarantine, hash, trust, IPC, and
VirusTotal behavior remains unchanged.

This PR intentionally does not introduce a general application-owned filename
policy or replace `extract-zip`.

## 2. Security finding

The current guard limits entry count and declared uncompressed sizes, but it
does not inspect entry type metadata. `extract-zip@2.0.1` can therefore create a
symbolic link supplied by an untrusted archive.

The dependency checks the canonical parent directory before extraction, but it
does not perform a no-follow check on the final destination. A later regular
entry with the same filename can consequently open the symlink path with normal
write semantics and write outside the extraction root.

Downstream `lstat` checks do not close this gap: they run after extraction, skip
the symlink, and cannot undo an external write that already occurred. Removing
the staging tree also removes only the link and staging contents, not the
external target.

The finding is proven for symlink-capable hosts. On Windows, baseline
materialization can instead fail with an OS privilege error, but that is not an
application-owned security policy and must not be relied upon.

## 3. Proven exploit sequence

The proven dependency-level sequence is:

1. An archive contains a symlink entry named `alias`.
2. The symlink target resolves outside the extraction root.
3. A later regular-file entry is also named `alias`.
4. `extract-zip` validates the canonical parent of `alias`, which is still the
   extraction root.
5. It does not canonicalize or reject the final existing symlink path.
6. `createWriteStream(alias, { mode })` uses normal truncating write semantics
   and follows the existing symbolic link.
7. The external target is created or overwritten with the archive entry data.
8. Cleanup removes the staging tree but does not restore the external target.

The future regression fixture must keep every effect inside a test-owned
sandbox. Its `outside` directory is outside `sandbox/extract` but remains inside
the same disposable `sandbox` directory. No target may point to a project file,
home directory, arbitrary temporary-directory sibling, or any other path not
owned by that individual test.

## 4. Baseline and branch

Planning baseline:

- repository branch: `security/zip-entry-policy`;
- `HEAD`: `738985c6a5ff74080c555b3d6855edf775178e58`;
- `main`: `738985c6a5ff74080c555b3d6855edf775178e58`;
- `origin/main`: `738985c6a5ff74080c555b3d6855edf775178e58`;
- unique feature commits: none;
- working tree before this document: clean.

Installed dependency behavior was verified from runtime source, not inferred
from a README:

- `extract-zip@2.0.1`;
- `yauzl@2.10.0`;
- `extract-zip` callback type: `(entry: yauzl.Entry, zipfile: yauzl.ZipFile) => void`.

The test suite already has `test/integration`, and `vitest.config.ts` includes
`test/**/*.test.ts`. Creating `test/integration/archive` therefore requires no
Vitest configuration change.

## 5. Exact scope

The planned PR file scope is exactly:

1. `docs/refactoring/zip-symlink-rejection-plan.md`;
2. `src/main/archive/zip-extraction-guard.ts`;
3. `test/unit/archive/zip-extraction-guard.test.ts`;
4. `test/helpers/zip-fixture.ts`;
5. `test/integration/archive/zip-symlink-rejection.test.ts`.

Production behavior change:

- keep the shared guard factory and both existing call sites;
- add the minimum entry metadata required for symlink classification;
- reject materializable symlink entries synchronously;
- preserve all count and size logic and error ordering for ordinary entries.

No new runtime dependency, public application service, Electron import, or ZIP
wrapper is required.

## 6. Out of scope

PR-3 must not include:

- a general filename or path policy;
- validation of raw backslashes;
- changing yauzl `strictFileNames`;
- duplicate or normalized-path collision detection;
- case-collision handling;
- Windows alternate-data-stream or general colon policy;
- Windows reserved device-name policy;
- NUL or path-length policy;
- rejection of other Unix entry types;
- final-destination no-follow or atomic-open work;
- a custom safe extraction wrapper;
- staging or cleanup changes;
- additional TOCTOU hardening;
- downloader, quarantine, antivirus, or VirusTotal changes;
- catalog or community trust changes;
- IPC, preload, renderer, or Supabase changes;
- changes to `src/main/index.ts` or `src/main/antivirus.ts`;
- changes to `src/main/archive/zip-validation.ts`;
- package, lockfile, dependency, Vitest, ESLint, TypeScript, coverage, or CI changes.

The PR description must not claim that all ZIP path risks are closed. It closes
the demonstrated symlink-materialization path only.

## 7. extract-zip lifecycle

The relevant `extract-zip@2.0.1` lifecycle is:

1. Ensure the extraction root exists and canonicalize it.
2. Open the ZIP with yauzl in lazy-entry mode.
3. Let yauzl decode, normalize, and validate the entry filename.
4. Receive the yauzl `entry` event.
5. Skip `__MACOSX/` entries before the application callback.
6. Compute the destination parent directory.
7. Create that parent directory.
8. Resolve the parent with `realpath` and reject an out-of-root parent.
9. Call application `onEntry(entry, zipfile)`.
10. Compute entry mode and directory/symlink classification.
11. Create the destination directory or regular-file parent directory.
12. Return for a directory.
13. Open the entry read stream.
14. Call `fs.symlink` for a symlink or stream to `createWriteStream` for a
    regular entry.

Consequences for this PR:

- the shared guard runs before entry read-stream creation;
- a synchronous guard throw prevents `fs.symlink` for the current entry;
- the ZIP is closed and extraction rejects through the dependency catch path;
- parent directories and earlier entries can already exist at the time of the
  throw;
- `extract-zip` does not remove the partial tree itself;
- both current application consumers remove their staging roots in `finally`.

The integration test must assert security-relevant output state, not claim that
the callback occurs before parent-directory creation.

## 8. Entry metadata and bitmask

### Production entry contract

Change the pure structural type from:

```ts
export interface ZipEntryLike {
  fileName: string
  uncompressedSize: number
}
```

to:

```ts
export interface ZipEntryLike {
  fileName: string
  uncompressedSize: number
  externalFileAttributes: number
}
```

`externalFileAttributes` should be required, not optional:

- every real `yauzl.Entry` declares it as a number;
- `extract-zip` reads it without an absence check;
- the existing unit helper can supply a regular default of `0` centrally;
- an optional field would define behavior for a runtime shape the production
  callback does not receive and could silently fail open.

Do not add `versionMadeBy` to `ZipEntryLike`. `extract-zip` does not use creator
OS when classifying symlinks. The real yauzl entry remains structurally
compatible with the guard callback, and a callback accepting one parameter is
compatible with the dependency callback that supplies a second `zipfile`
parameter.

Do not import yauzl or extract-zip types into the pure guard.

### Exact formula

The implementation must match `extract-zip@2.0.1`:

```text
mode = (externalFileAttributes >> 16) & 0xFFFF
type = mode & 0xF000
symlink = type === 0xA000
```

Equivalent named constants may be used, but the signed right shift and masks
must be reviewable against the dependency source. In particular:

- `0xFFFF` selects the upper 16-bit Unix mode;
- `0xF000` is the Unix file-type mask;
- `0xA000` is the symlink type;
- lower permission bits do not affect classification;
- creator OS must not gate the decision;
- malformed/FAT-style metadata with the same type bits must be rejected because
  `extract-zip` can also materialize it as a symlink.

Use a private helper such as `isZipSymlinkEntry(entry)` if it makes the bitmask
readable. Do not export a new API solely for testing; all behavior is observable
through `makeZipExtractionGuard()`.

## 9. Guard contract and ordering

The exact new guard order is:

1. If `entry.fileName.endsWith('/')`, return immediately.
2. Derive the Unix mode and type from `externalFileAttributes`.
3. If the type is symlink, throw synchronously.
4. Increment `fileCount`.
5. Check `MAX_EXTRACTED_FILES`.
6. Normalize the declared size exactly as today with
   `Number(entry.uncompressedSize) || 0`.
7. Check `MAX_SINGLE_FILE_BYTES`.
8. Add the size to `totalBytes`.
9. Check `MAX_TOTAL_UNCOMPRESSED_BYTES`.

Directory skip remains first because `extract-zip` applies directory semantics
to a trailing-slash name before it can reach its `fs.symlink` branch. A
trailing-slash entry with symlink type bits is therefore not materialized as a
symlink. Changing that compatibility behavior is not needed to close the proven
write path.

The new failure must occur before both mutable counters change. After a rejected
symlink:

- `fileCount` remains unchanged;
- `totalBytes` remains unchanged;
- the same guard behaves as if that entry had never consumed limits.

For all non-symlink files, existing error precedence remains:

1. file count;
2. single-file size;
3. total uncompressed size.

Fresh state per factory call remains mandatory.

## 10. Error contract

The only new production error is:

```text
Символические ссылки внутри ZIP-архива запрещены.
```

Requirements:

- install and antivirus extraction receive the same exact message through the
  same shared guard;
- tests compare `error.message` with `toBe`, never a substring matcher;
- the message contains no entry filename;
- the message contains no symlink target;
- the message contains no absolute local path;
- existing count and size error strings remain byte-for-byte unchanged.

The current `toSafeError` trims and returns ordinary non-sensitive error
messages unchanged. This Russian message does not match the sensitive server,
network, timeout, or upload-size mappings, so it reaches both current error
boundaries without leaking local details. The implementation review should
retain a focused assertion that passing the caught error through `toSafeError`
produces the same exact message.

## 11. Fixture changes

Extend `test/helpers/zip-fixture.ts` with optional test-only central-directory
metadata:

```ts
externalFileAttributes?: number
versionMadeBy?: number
```

Defaults must preserve every current fixture:

- `externalFileAttributes`: `0`;
- `versionMadeBy`: `20`, the current value.

Binary layout requirements:

- central-directory `version made by` is a 2-byte little-endian value at offset
  `4` from the central-directory header signature;
- central-directory `external file attributes` is a 4-byte little-endian value
  at offset `38`;
- reuse the existing `u16` and `u32` writers;
- `u32` must continue normalizing with `>>> 0` before `writeUInt32LE`;
- do not change the local file header because these metadata fields are central
  directory fields;
- keep existing ZIP64 and forged-size behavior unchanged;
- keep duplicate filenames possible by leaving `buildZip(entries)` ordered and
  non-deduplicating.

`versionMadeBy` is not needed by production detection. It is included only so a
test can encode a conventionally correct Unix-created symlink fixture, for
example creator OS `3` in the high byte and ZIP version `20` in the low byte.
Separate malformed/FAT-style coverage proves that production rejection does not
depend on this field.

The symlink entry data contains the link target bytes. The integration target
must be a relative path from `sandbox/extract` to `sandbox/outside`, never a path
outside the test-owned sandbox.

No fixture dependency may be added.

## 12. Unit test matrix

Extend `test/unit/archive/zip-extraction-guard.test.ts` while preserving all 23
existing tests.

Use a single entry factory with a regular default:

```text
entry(fileName, uncompressedSize, externalFileAttributes = 0)
```

If useful, a test-only encoder may convert a 16-bit Unix mode into the unsigned
central-directory attribute value. Keep the encoding helper separate from the
production classification logic so tests do not merely copy the implementation.

Required cases:

1. Unix symlink type `0xA000` is rejected.
2. Symlink mode `0xA1FF` is rejected.
3. Different lower permission bits do not affect rejection.
4. A malformed/FAT-style entry with symlink bits is rejected without any
   creator-OS condition.
5. Regular-file type `0x8000` is accepted.
6. Directory type `0x4000` with trailing slash preserves directory skip.
7. An entry without Unix type bits is accepted.
8. `externalFileAttributes = 0` is accepted.
9. The exact symlink error is checked through `error.message` and `toBe` using
   the existing `expectExactError` helper.
10. Symlink rejection occurs before file-count mutation.
11. Symlink rejection occurs before total-size mutation.
12. A symlink with an oversized declared size produces the symlink error, not a
    single-file-size error.
13. After symlink rejection, the same guard still accepts exactly the original
    remaining file-count budget.
14. After symlink rejection, the same guard still accepts exactly the original
    total-size budget.
15. Two guard factories retain independent state.
16. All existing 23 tests continue to pass.
17. Existing count, single-size, and total-size error precedence is unchanged.

State tests must use public behavior and limits; they must not inspect closure
state. No test may use `any`, `@ts-ignore`, `@ts-nocheck`, `eslint-disable`, or a
string-form `toThrow` matcher when exact production text is asserted.

## 13. Integration regression design

Create:

```text
test/integration/archive/zip-symlink-rejection.test.ts
```

The existing `test/integration` convention already uses real filesystem
operations inside a disposable directory. The new `archive` subdirectory is
covered by the existing Vitest glob, so no configuration change is required.

Each test owns this layout:

```text
sandbox/
├── fixture.zip
├── extract/
└── outside/
    └── sentinel.txt
```

The main regression archive contains:

1. a conventionally encoded Unix symlink entry named `alias`, whose data points
   to `../outside/sentinel.txt` relative to the extraction root and therefore
   remains inside the test-owned sandbox;
2. a later regular entry with the same name `alias` and different bytes.

The test invokes the real production API:

```ts
extractZip(zipPath, {
  dir: extractDir,
  onEntry: makeZipExtractionGuard()
})
```

It must verify:

- the Promise rejects;
- the rejection value is an `Error`;
- `error.message` exactly equals the symlink error through `toBe`;
- the sentinel still contains its original bytes;
- no symlink or regular file named `alias` was materialized in the extraction
  root;
- `toSafeError(error, fallback)` returns the exact same safe message;
- extraction-root cleanup runs in `finally`;
- whole-sandbox cleanup runs in `afterEach` or an outer `finally`.

Use `lstat`-based absence checking when necessary: `existsSync` alone reports
false for a dangling symlink and is not sufficient to prove that no filesystem
entry was created.

A second integration case may use a non-existing target inside
`sandbox/outside` and must assert that the target remains absent. It is useful
for covering both external overwrite and external creation, but it must use the
same production guard and the same strict rejection assertion.

The fixture ZIP and every extracted artifact must remain inside `sandbox`.

### RED phase

Before the production fix:

- the pure guard symlink test is mandatory RED because the guard does not throw;
- on POSIX, the real extraction regression can overwrite the sandbox sentinel
  or otherwise fail to produce the required application error;
- on Windows, `fs.symlink` can fail with `EPERM` before overwrite if the process
  lacks symlink privilege;
- an OS error is not proof of application protection because its message is not
  the required guard error and behavior changes with privileges.

The portable RED criterion is therefore the failed pure guard assertion plus
failure to observe the exact application-owned error in real extraction. Do not
make actual external overwrite a cross-platform prerequisite for RED.

### GREEN phase

After the production fix, real extraction must pass on every supported CI
platform because the synchronous callback throws before `fs.symlink`. The test
must never be weakened with a platform `.skip`, conditional success for `EPERM`,
or an assertion that accepts either the guard error or an OS error.

No permanent `.skip`, `.todo`, or `.only` is allowed.

## 14. Cross-platform behavior

POSIX systems normally allow creation of the archive-supplied symbolic link, so
the baseline duplicate-entry sequence can demonstrate the external write inside
the controlled sandbox.

Windows can require Developer Mode, administrative privilege, or another
symlink permission. Baseline `EPERM` is environmental fail-closed behavior, not
the required policy. PR-3 must make the result independent of that permission:

- yauzl emits the entry metadata;
- the application callback detects the symlink bits;
- the callback throws synchronously;
- `extract-zip` rejects before calling `fs.symlink`;
- the exact Russian policy error is identical on Windows, macOS, and Linux.

The test target uses only paths inside the disposable sandbox. It must not use
platform user directories, repository files, or an arbitrary absolute target.

## 15. Implementation steps

1. Reconfirm the branch, baseline commit, and clean status.
2. Add RED unit tests for exact symlink classification, error text, ordering,
   counter state, and ordinary mode compatibility.
3. Extend the test entry factory with default `externalFileAttributes = 0` so
   existing tests compile without scattered magic values.
4. Extend `zip-fixture.ts` with optional central-directory
   `externalFileAttributes` and `versionMadeBy`, retaining current defaults.
5. Add the real `extract-zip` sandbox regression and confirm its portable RED
   assertion is the missing exact application error.
6. Add required `externalFileAttributes` to `ZipEntryLike`.
7. Add a private, exact bitmask helper or equally readable inline calculation.
8. Insert symlink rejection after trailing-slash directory skip and before any
   counter mutation.
9. Keep every existing count/size statement and error string unchanged.
10. Run focused unit, archive, and integration tests.
11. Run lint, typecheck, complete tests, coverage, build, and `npm run check`.
12. Review the final diff for the exact five-file scope and perform an
    independent security review.

Do not modify either extraction call site: both already create a fresh shared
guard with `onEntry: makeZipExtractionGuard()`.

## 16. Verification commands

Focused verification:

```sh
npx vitest run test/unit/archive/zip-extraction-guard.test.ts
npx vitest run test/unit/archive
npx vitest run test/integration/archive/zip-symlink-rejection.test.ts
```

Full verification:

```sh
npm run lint
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run check
```

Review verification:

```sh
git diff --check
git status --short --untracked-files=all
git diff --stat
git diff --name-status
```

Coverage review must confirm that both the symlink rejection branch and normal
non-symlink path are exercised. Existing count/size coverage must not regress.

No thresholds or configuration may be relaxed to make verification pass.

## 17. Compatibility impact

Intentional behavior change:

- before PR-3, a ZIP symlink could be materialized and then usually skipped by
  downstream antivirus/install traversal;
- after PR-3, the first materializable symlink entry rejects the entire archive.

Legitimate Unix or macOS archives containing symlinks will no longer install,
even if the link is internal or optional. This is an acknowledged compatibility
cost. Such archives were already handled incompletely because downstream code
skips links during scanning, VST3 discovery, and recursive copy.

Fail-closed whole-archive rejection is preferred to silently skipping links:

- continuing extraction retains complicated duplicate-path behavior;
- a partial install is ambiguous and may omit required bundle content;
- antivirus and install extraction must enforce one identical policy;
- supporting selected links safely would require target validation, duplicate
  tracking, and final-destination controls outside this PR.

## 18. Risks and rollback

| Risk | Required mitigation |
|---|---|
| Wrong bitmask | Compare named constants and formula directly with installed `extract-zip@2.0.1`; cover exact modes. |
| Signed-shift mistake | Preserve `(attributes >> 16) & 0xFFFF`; test an unsigned 32-bit encoded symlink value. |
| Formula drifts from dependency | Characterize real extraction with the fixture, not only synthetic unit objects. |
| Trailing-slash precedence changes | Keep directory skip first and add a regression test. |
| Counter mutation before throw | Assert full count and total budgets remain after symlink failure. |
| Optional metadata fails open | Make production `externalFileAttributes` required. |
| Structural callback incompatibility | Typecheck real call sites against `yauzl.Entry`. |
| Fixture offset corruption | Use documented central offsets, little-endian helpers, and run all existing archive tests. |
| Fixture never reaches real `onEntry` | Require exact application error from real `extractZip`; an OS/dependency error fails the test. |
| Windows symlink privilege masks behavior | GREEN requires callback error before OS symlink handling; never accept `EPERM`. |
| Test writes outside sandbox | Construct target only under test-owned `sandbox/outside` and assert resolved test paths remain under `sandbox`. |
| Partial extraction remains | Always remove extraction root in `finally` and sandbox in `afterEach`/outer `finally`. |
| Overclaiming security | State explicitly that filename, duplicate-path, no-follow, and TOCTOU work remains. |
| Scope creep | Enforce the five-file scope and reject broad filename-policy changes in review. |
| Legitimate symlink archive rejected | Document the intentional fail-closed compatibility change. |

Rollback is small and direct: revert the guard metadata field/check and its
tests/fixture support. No schema, migration, dependency, call-site, or persisted
state rollback is required.

## 19. Definition of Done

PR-3 is complete only when:

- the shared guard rejects every non-trailing-slash entry that the exact
  `extract-zip@2.0.1` bitmask classifies as symlink;
- rejection happens synchronously before read-stream and symlink
  materialization;
- the exact Russian error is locked with strict equality;
- the error passes through current `toSafeError` unchanged;
- install and antivirus receive the protection without call-site changes;
- a symlink failure does not mutate file count or total bytes;
- existing directory and count/single/total ordering remains unchanged;
- all existing 23 guard tests pass;
- all existing archive tests pass;
- the real `extract-zip` regression passes on supported CI platforms;
- the sandbox sentinel outside the extraction root remains byte-for-byte
  unchanged;
- any non-existing sandbox target remains absent when that case is included;
- no symlink entry is materialized;
- partial extraction and sandbox cleanup is deterministic;
- package, dependencies, configuration, thresholds, and CI are unchanged;
- full verification and CI are green;
- the final diff contains only the planned five files;
- an independent security review returns `APPROVED`.

## 20. Follow-up backlog

Separate follow-up work, not a condition of PR-3:

1. Define an application-owned normalized filename policy.
2. Decide whether raw backslash rejection requires direct yauzl usage or a safe
   extraction wrapper.
3. Track and reject duplicate normalized destinations.
4. Define Windows case-collision behavior.
5. Define Windows colon/ADS and reserved device-name policy.
6. Define NUL, component-length, and total-path-length policy.
7. Decide whether FIFO, device, socket, and other Unix types should be rejected.
8. Add final-destination no-follow or atomic-open protection.
9. Analyze residual realpath-to-open and scan-to-install TOCTOU windows.
10. Evaluate a dedicated safe extraction wrapper as a larger isolated project.
11. Evaluate crash-safe cleanup for abandoned staging trees.
12. Gather compatibility evidence from real plugin archives before broadening
    accepted/rejected filename behavior.
