// Test-only ZIP fixture builder — НЕ production-код.
//
// Зачем свой билдер, а не готовая библиотека (например, yazl): характеризационные
// тесты findZipEntry должны уметь ПОДДЕЛЫВАТЬ поле uncompressedSize в central
// directory независимо от реальных данных. Кейсы «файл слишком большой» и
// «превышение суммарного размера» опираются на объявленный размер (4 GiB+),
// который невозможно записать реальными байтами. yazl такого форжа не даёт, а
// добавлять новую зависимость на этом этапе запрещено. Билдер минимальный
// (STORED + при необходимости deflate-метод для форжа), детерминированный, не
// пишет гигабайты на диск и не выделяет гигабайты памяти.
//
// Изменяемые/подделываемые поля ZIP:
//   • central directory `uncompressed size` (offset 24) — форж лимит-кейсов;
//   • при size ≥ 0xffffffff добавляется ZIP64 extended information extra field
//     (id 0x0001) c 8-байтовым original size (yauzl читает его, когда поле в
//     central dir равно 0xffffffff — см. node_modules/yauzl/index.js);
//   • compression method (offset 10) — 8 (deflate) для форженых записей, чтобы
//     обойти проверку yauzl `compressed/uncompressed size mismatch`, которая
//     применяется только к STORED (method 0). Поток такой записи в лимит-кейсах
//     не открывается (guard срабатывает на событии `entry`), поэтому реальные
//     сжатые данные не нужны.
// Структура остаётся ровно настолько валидной, насколько требует yauzl с
// lazyEntries: корректные сигнатуры local/central header + EOCD, реальные данные
// только для STORED-записей, которые тест действительно читает.

const LOCAL_FILE_HEADER_SIG = 0x04034b50
const CENTRAL_DIR_HEADER_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const ZIP64_EXTRA_ID = 0x0001
const UINT32_MAX = 0xffffffff

const METHOD_STORED = 0
const METHOD_DEFLATE = 8

export interface ZipEntrySpec {
  /** Имя записи в архиве. Директория — имя, оканчивающееся на '/'. */
  name: string
  /** Реальные (STORED) данные записи. По умолчанию пустой буфер. */
  data?: Buffer
  /**
   * Подделать central-directory uncompressedSize независимо от data.
   * Использует deflate-метод (8), чтобы обойти stored-size-валидацию yauzl.
   * Поток такой записи открывать нельзя (в лимит-кейсах он и не открывается).
   */
  forgedUncompressedSize?: number
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value, 0)
  return b
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value >>> 0, 0)
  return b
}

function u64(value: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(value), 0)
  return b
}

function sig(value: number): Buffer {
  return u32(value)
}

interface BuiltEntry {
  localHeaderWithData: Buffer
  centralHeader: Buffer
  localOffset: number
}

function buildEntry(spec: ZipEntrySpec, localOffset: number): BuiltEntry {
  const nameBuf = Buffer.from(spec.name, 'utf8')
  const data = spec.data ?? Buffer.alloc(0)
  const forged = spec.forgedUncompressedSize !== undefined

  const method = forged ? METHOD_DEFLATE : METHOD_STORED
  // Реальные данные пишем только для STORED-записей (их тест может прочитать).
  const localData = forged ? Buffer.alloc(0) : data
  const localCompressedSize = localData.length
  const localUncompressedSize = localData.length

  const declaredUncompressed = forged ? (spec.forgedUncompressedSize as number) : data.length
  const needsZip64 = declaredUncompressed >= UINT32_MAX

  // ── Local file header (yauzl читает его только при openReadStream) ──
  const local = Buffer.concat([
    sig(LOCAL_FILE_HEADER_SIG),
    u16(20), // version needed
    u16(0), // gp flag
    u16(method),
    u16(0), // mod time
    u16(0), // mod date
    u32(0), // crc32 (yauzl не проверяет crc)
    u32(localCompressedSize),
    u32(localUncompressedSize),
    u16(nameBuf.length),
    u16(0), // extra len
    nameBuf
  ])
  const localHeaderWithData = Buffer.concat([local, localData])

  // ── Central directory header ──
  const centralUncompressedField = needsZip64 ? UINT32_MAX : declaredUncompressed
  const centralCompressedField = forged ? 0 : data.length
  const zip64Extra = needsZip64
    ? Buffer.concat([u16(ZIP64_EXTRA_ID), u16(8), u64(declaredUncompressed)])
    : Buffer.alloc(0)

  const central = Buffer.concat([
    sig(CENTRAL_DIR_HEADER_SIG),
    u16(20), // version made by
    u16(needsZip64 ? 45 : 20), // version needed
    u16(0), // gp flag
    u16(method),
    u16(0), // mod time
    u16(0), // mod date
    u32(0), // crc32
    u32(centralCompressedField),
    u32(centralUncompressedField),
    u16(nameBuf.length),
    u16(zip64Extra.length),
    u16(0), // comment len
    u16(0), // disk number
    u16(0), // internal attrs
    u32(0), // external attrs
    u32(localOffset),
    nameBuf,
    zip64Extra
  ])

  return { localHeaderWithData, centralHeader: central, localOffset }
}

/**
 * Собирает валидный (для yauzl с lazyEntries) ZIP-архив в память из спецификаций
 * записей. Директории задаются именем с завершающим '/'.
 */
export function buildZip(entries: ZipEntrySpec[]): Buffer {
  const built: BuiltEntry[] = []
  const localParts: Buffer[] = []
  let offset = 0
  for (const spec of entries) {
    const entry = buildEntry(spec, offset)
    built.push(entry)
    localParts.push(entry.localHeaderWithData)
    offset += entry.localHeaderWithData.length
  }

  const centralParts = built.map((b) => b.centralHeader)
  const centralDirectory = Buffer.concat(centralParts)
  const centralDirectoryOffset = offset

  const eocd = Buffer.concat([
    sig(EOCD_SIG),
    u16(0), // disk number
    u16(0), // disk with central dir
    u16(entries.length), // entries this disk
    u16(entries.length), // total entries
    u32(centralDirectory.length),
    u32(centralDirectoryOffset),
    u16(0) // comment len
  ])

  return Buffer.concat([...localParts, centralDirectory, eocd])
}

/** Валидный ZIP-magic префикс (504b0304) — для тестов, мокающих yauzl.open. */
export function zipMagicPrefix(): Buffer {
  return sig(LOCAL_FILE_HEADER_SIG)
}
