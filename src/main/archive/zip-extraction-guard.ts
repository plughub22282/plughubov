import {
  MAX_EXTRACTED_FILES,
  MAX_SINGLE_FILE_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES
} from './zip-validation'

export interface ZipEntryLike {
  fileName: string
  uncompressedSize: number
}

export function makeZipExtractionGuard(): (entry: ZipEntryLike) => void {
  let fileCount = 0
  let totalBytes = 0
  return (entry: ZipEntryLike): void => {
    if (entry.fileName.endsWith('/')) return
    fileCount += 1
    if (fileCount > MAX_EXTRACTED_FILES) {
      throw new Error('В архиве слишком много файлов.')
    }
    const size = Number(entry.uncompressedSize) || 0
    if (size > MAX_SINGLE_FILE_BYTES) {
      throw new Error('Файл внутри архива слишком большой.')
    }
    totalBytes += size
    if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('Содержимое архива превышает допустимый размер.')
    }
  }
}
