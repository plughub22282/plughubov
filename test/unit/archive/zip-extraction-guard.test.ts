import { describe, it, expect } from 'vitest'
import {
  makeZipExtractionGuard,
  type ZipEntryLike
} from '../../../src/main/archive/zip-extraction-guard'
import {
  MAX_EXTRACTED_FILES,
  MAX_SINGLE_FILE_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES
} from '../../../src/main/archive/zip-validation'

const TOO_MANY_MESSAGE = 'В архиве слишком много файлов.'
const TOO_BIG_MESSAGE = 'Файл внутри архива слишком большой.'
const TOO_LARGE_TOTAL_MESSAGE = 'Содержимое архива превышает допустимый размер.'
const SYMLINK_MESSAGE = 'Символические ссылки внутри ZIP-архива запрещены.'

const SYMLINK_ATTRIBUTES = 0xa0000000
const SYMLINK_WITH_PERMISSIONS_ATTRIBUTES = 0xa1ff0000
const SYMLINK_WITH_OTHER_PERMISSIONS_ATTRIBUTES = 0xa1240000
const REGULAR_FILE_ATTRIBUTES = 0x80000000
const DIRECTORY_ATTRIBUTES = 0x40000000
const PERMISSIONS_WITHOUT_TYPE_ATTRIBUTES = 0x01ff0000

function entry(
  fileName: string,
  uncompressedSize: number,
  externalFileAttributes = 0
): ZipEntryLike {
  const zipEntry = { fileName, uncompressedSize, externalFileAttributes }
  return zipEntry
}

function expectExactError(run: () => void, expectedMessage: string): void {
  try {
    run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(expectedMessage)
    return
  }

  throw new Error(`Expected function to throw: ${expectedMessage}`)
}

function addFiles(
  guard: (entry: ZipEntryLike) => void,
  count: number,
  uncompressedSize = 0
): void {
  for (let index = 0; index < count; index++) {
    guard(entry(`file-${index}.bin`, uncompressedSize))
  }
}

describe('makeZipExtractionGuard — базовое поведение', () => {
  it('принимает обычный файл', () => {
    const guard = makeZipExtractionGuard()
    expect(() => guard(entry('plugin.vst3', 1024))).not.toThrow()
  })

  it('принимает запись директории', () => {
    const guard = makeZipExtractionGuard()
    expect(() => guard(entry('bundle/', MAX_SINGLE_FILE_BYTES + 1))).not.toThrow()
  })

  it('директории не расходуют лимиты', () => {
    const guard = makeZipExtractionGuard()
    for (let index = 0; index <= MAX_EXTRACTED_FILES; index++) {
      guard(entry(`directory-${index}/`, MAX_SINGLE_FILE_BYTES + 1))
    }
    expect(() => guard(entry('first-file.bin', 1))).not.toThrow()
  })
})

describe('makeZipExtractionGuard — состояние и lifecycle', () => {
  it('каждый вызов фабрики создаёт независимые счётчики', () => {
    const firstGuard = makeZipExtractionGuard()
    const secondGuard = makeZipExtractionGuard()
    addFiles(firstGuard, MAX_EXTRACTED_FILES)

    expect(() => secondGuard(entry('independent.bin', 1))).not.toThrow()
    expectExactError(() => firstGuard(entry('overflow.bin', 1)), TOO_MANY_MESSAGE)
    expect(() => secondGuard(entry('still-independent.bin', 1))).not.toThrow()
  })

  it('бросает ошибку синхронно', () => {
    const guard = makeZipExtractionGuard()
    expectExactError(() => guard(entry('infinite.bin', Infinity)), TOO_BIG_MESSAGE)
  })
})

describe('makeZipExtractionGuard — политика символических ссылок', () => {
  it('отклоняет Unix symlink type 0xa000', () => {
    const guard = makeZipExtractionGuard()
    expectExactError(() => guard(entry('link', 1, SYMLINK_ATTRIBUTES)), SYMLINK_MESSAGE)
  })

  it('отклоняет symlink mode с permission bits', () => {
    const guard = makeZipExtractionGuard()
    expectExactError(
      () => guard(entry('link-with-permissions', 1, SYMLINK_WITH_PERMISSIONS_ATTRIBUTES)),
      SYMLINK_MESSAGE
    )
  })

  it('не зависит от значений нижних permission bits', () => {
    const guard = makeZipExtractionGuard()
    expectExactError(
      () => guard(entry('first-link', 1, SYMLINK_WITH_PERMISSIONS_ATTRIBUTES)),
      SYMLINK_MESSAGE
    )
    expectExactError(
      () => guard(entry('second-link', 1, SYMLINK_WITH_OTHER_PERMISSIONS_ATTRIBUTES)),
      SYMLINK_MESSAGE
    )
  })

  it('не зависит от creator OS metadata', () => {
    const guard = makeZipExtractionGuard()
    const fatStyleEntry = {
      ...entry('fat-style-link', 1, SYMLINK_ATTRIBUTES),
      versionMadeBy: 20
    }

    expectExactError(() => guard(fatStyleEntry), SYMLINK_MESSAGE)
  })

  it('разрешает regular-file mode 0x8000', () => {
    const guard = makeZipExtractionGuard()
    expect(() => guard(entry('regular.bin', 1, REGULAR_FILE_ATTRIBUTES))).not.toThrow()
  })

  it('разрешает entry без Unix type bits', () => {
    const guard = makeZipExtractionGuard()
    expect(() => guard(entry('permissions-only.bin', 1, PERMISSIONS_WITHOUT_TYPE_ATTRIBUTES))).not.toThrow()
  })

  it('разрешает externalFileAttributes=0', () => {
    const guard = makeZipExtractionGuard()
    expect(() => guard(entry('no-attributes.bin', 1, 0))).not.toThrow()
  })

  it('сохраняет precedence trailing-slash directory над symlink bits', () => {
    const guard = makeZipExtractionGuard()
    expect(() => guard(entry('link-shaped-directory/', MAX_SINGLE_FILE_BYTES + 1, SYMLINK_ATTRIBUTES))).not.toThrow()
  })

  it('сохраняет directory skip для directory mode с trailing slash', () => {
    const guard = makeZipExtractionGuard()
    expect(() => guard(entry('directory/', MAX_SINGLE_FILE_BYTES + 1, DIRECTORY_ATTRIBUTES))).not.toThrow()
  })
})

describe('makeZipExtractionGuard — порядок и состояние при symlink failure', () => {
  it('возвращает symlink error раньше single-file-size error', () => {
    const guard = makeZipExtractionGuard()
    expectExactError(
      () => guard(entry('oversized-link', MAX_SINGLE_FILE_BYTES + 1, SYMLINK_ATTRIBUTES)),
      SYMLINK_MESSAGE
    )
  })

  it('возвращает symlink error раньше file-count error', () => {
    const guard = makeZipExtractionGuard()
    addFiles(guard, MAX_EXTRACTED_FILES)
    expectExactError(() => guard(entry('link-after-limit', 1, SYMLINK_ATTRIBUTES)), SYMLINK_MESSAGE)
  })

  it('возвращает symlink error раньше total-size error', () => {
    const guard = makeZipExtractionGuard()
    guard(entry('maximum.bin', MAX_TOTAL_UNCOMPRESSED_BYTES))
    expectExactError(() => guard(entry('link-after-total', 1, SYMLINK_ATTRIBUTES)), SYMLINK_MESSAGE)
  })

  it('не изменяет fileCount после symlink throw', () => {
    const guard = makeZipExtractionGuard()
    expectExactError(() => guard(entry('link', 1, SYMLINK_ATTRIBUTES)), SYMLINK_MESSAGE)
    expect(() => addFiles(guard, MAX_EXTRACTED_FILES)).not.toThrow()
    expectExactError(() => guard(entry('one-too-many.bin', 0)), TOO_MANY_MESSAGE)
  })

  it('не изменяет totalBytes после symlink throw', () => {
    const guard = makeZipExtractionGuard()
    expectExactError(
      () => guard(entry('maximum-sized-link', MAX_TOTAL_UNCOMPRESSED_BYTES, SYMLINK_ATTRIBUTES)),
      SYMLINK_MESSAGE
    )
    expect(() => guard(entry('maximum.bin', MAX_TOTAL_UNCOMPRESSED_BYTES))).not.toThrow()
    expectExactError(() => guard(entry('over-total.bin', 1)), TOO_LARGE_TOTAL_MESSAGE)
  })
})

describe('makeZipExtractionGuard — лимит количества файлов', () => {
  it('принимает ровно MAX_EXTRACTED_FILES файлов', () => {
    const guard = makeZipExtractionGuard()
    expect(() => addFiles(guard, MAX_EXTRACTED_FILES)).not.toThrow()
  })

  it('отклоняет MAX_EXTRACTED_FILES + 1 файл полным сообщением', () => {
    const guard = makeZipExtractionGuard()
    addFiles(guard, MAX_EXTRACTED_FILES)
    expectExactError(() => guard(entry('one-too-many.bin', 0)), TOO_MANY_MESSAGE)
  })

  it('директории не влияют на границу количества', () => {
    const guard = makeZipExtractionGuard()
    addFiles(guard, MAX_EXTRACTED_FILES - 1)
    guard(entry('before-boundary/', 0))
    expect(() => guard(entry('at-boundary.bin', 0))).not.toThrow()
    guard(entry('after-boundary/', 0))
    expectExactError(() => guard(entry('over-boundary.bin', 0)), TOO_MANY_MESSAGE)
  })
})

describe('makeZipExtractionGuard — лимит одного файла', () => {
  it('принимает размер ровно MAX_SINGLE_FILE_BYTES', () => {
    const guard = makeZipExtractionGuard()
    expect(() => guard(entry('maximum.bin', MAX_SINGLE_FILE_BYTES))).not.toThrow()
  })

  it('отклоняет MAX_SINGLE_FILE_BYTES + 1 полным сообщением', () => {
    const guard = makeZipExtractionGuard()
    expectExactError(() => guard(entry('too-big.bin', MAX_SINGLE_FILE_BYTES + 1)), TOO_BIG_MESSAGE)
  })
})

describe('makeZipExtractionGuard — суммарный лимит', () => {
  it('принимает суммарно ровно MAX_TOTAL_UNCOMPRESSED_BYTES', () => {
    const guard = makeZipExtractionGuard()
    const half = MAX_TOTAL_UNCOMPRESSED_BYTES / 2
    guard(entry('first-half.bin', half))
    expect(() => guard(entry('second-half.bin', half))).not.toThrow()
  })

  it('отклоняет сумму MAX_TOTAL_UNCOMPRESSED_BYTES + 1 полным сообщением', () => {
    const guard = makeZipExtractionGuard()
    const half = MAX_TOTAL_UNCOMPRESSED_BYTES / 2
    guard(entry('first-half.bin', half))
    expectExactError(() => guard(entry('second-half-plus-one.bin', half + 1)), TOO_LARGE_TOTAL_MESSAGE)
  })

  it('директории не влияют на границу суммарного размера', () => {
    const guard = makeZipExtractionGuard()
    const half = MAX_TOTAL_UNCOMPRESSED_BYTES / 2
    guard(entry('before-total/', MAX_SINGLE_FILE_BYTES + 1))
    guard(entry('first-half.bin', half))
    guard(entry('between-halves/', MAX_SINGLE_FILE_BYTES + 1))
    expect(() => guard(entry('second-half.bin', half))).not.toThrow()
    guard(entry('after-total/', MAX_SINGLE_FILE_BYTES + 1))
    expectExactError(() => guard(entry('over-total.bin', 1)), TOO_LARGE_TOTAL_MESSAGE)
  })
})

describe('makeZipExtractionGuard — порядок проверок', () => {
  it('проверяет размер одного файла раньше суммарного размера', () => {
    const guard = makeZipExtractionGuard()
    guard(entry('existing.bin', 1))
    expectExactError(() => guard(entry('too-big.bin', MAX_SINGLE_FILE_BYTES + 1)), TOO_BIG_MESSAGE)
  })

  it('проверяет количество раньше размера файла', () => {
    const guard = makeZipExtractionGuard()
    addFiles(guard, MAX_EXTRACTED_FILES)
    expectExactError(() => guard(entry('too-many-and-too-big.bin', MAX_SINGLE_FILE_BYTES + 1)), TOO_MANY_MESSAGE)
  })
})

describe('makeZipExtractionGuard — состояние после ошибки', () => {
  it('не сбрасывает счётчик после ошибки количества', () => {
    const guard = makeZipExtractionGuard()
    addFiles(guard, MAX_EXTRACTED_FILES)
    expectExactError(() => guard(entry('first-overflow.bin', 0)), TOO_MANY_MESSAGE)
    expectExactError(() => guard(entry('second-overflow.bin', 0)), TOO_MANY_MESSAGE)
  })

  it('учитывает файл в количестве, но не в сумме после ошибки его размера', () => {
    const guard = makeZipExtractionGuard()
    expectExactError(() => guard(entry('too-big.bin', MAX_SINGLE_FILE_BYTES + 1)), TOO_BIG_MESSAGE)
    expect(() => guard(entry('maximum.bin', MAX_SINGLE_FILE_BYTES))).not.toThrow()
    addFiles(guard, MAX_EXTRACTED_FILES - 2)
    expectExactError(() => guard(entry('count-overflow.bin', 0)), TOO_MANY_MESSAGE)
  })

  it('сохраняет превышенную сумму после ошибки суммарного размера', () => {
    const guard = makeZipExtractionGuard()
    guard(entry('maximum.bin', MAX_TOTAL_UNCOMPRESSED_BYTES))
    expectExactError(() => guard(entry('first-overflow.bin', 1)), TOO_LARGE_TOTAL_MESSAGE)
    expectExactError(() => guard(entry('second-overflow.bin', 0)), TOO_LARGE_TOTAL_MESSAGE)
  })
})

describe('makeZipExtractionGuard — необычные значения размера', () => {
  it('трактует uncompressedSize=0 как нулевой размер', () => {
    const guard = makeZipExtractionGuard()
    expect(() => guard(entry('empty.bin', 0))).not.toThrow()
  })

  it('сохраняет отрицательное значение в текущей арифметике суммы', () => {
    const guard = makeZipExtractionGuard()
    guard(entry('negative.bin', -1))
    guard(entry('maximum.bin', MAX_TOTAL_UNCOMPRESSED_BYTES))
    expect(() => guard(entry('offset.bin', 1))).not.toThrow()
    expectExactError(() => guard(entry('overflow.bin', 1)), TOO_LARGE_TOTAL_MESSAGE)
  })

  it('трактует NaN как нулевой размер', () => {
    const guard = makeZipExtractionGuard()
    expect(() => guard(entry('nan.bin', NaN))).not.toThrow()
  })

  it('отклоняет Infinity по лимиту одного файла', () => {
    const guard = makeZipExtractionGuard()
    expectExactError(() => guard(entry('infinite.bin', Infinity)), TOO_BIG_MESSAGE)
  })

  it('трактует отсутствующее и нечисловое значение как нулевой размер', () => {
    const guard = makeZipExtractionGuard()
    const missingSize = {
      fileName: 'missing.bin',
      externalFileAttributes: 0
    } as unknown as ZipEntryLike
    const nonNumericSize = {
      fileName: 'non-numeric.bin',
      uncompressedSize: 'not-a-number',
      externalFileAttributes: 0
    } as unknown as ZipEntryLike

    expect(() => guard(missingSize)).not.toThrow()
    expect(() => guard(nonNumericSize)).not.toThrow()
  })
})
