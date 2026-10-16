/**
 * Multi-frame Zstandard reader for DSH session logs.
 *
 * DSH's JSONL persistence writes one independently decodable Zstandard frame
 * per appended batch, so a session artifact is a concatenation of frames.
 * Node's one-shot `zstdDecompressSync` stops after the first frame, so we
 * locate frame boundaries ourselves and decompress each range separately.
 *
 * The boundary scan mirrors `scanZstdFrames` from
 * `@deepseek-ai/dsh-session-persistence-jsonl` (frame header + block headers),
 * reimplemented here so the workbench stays dependency-free.
 */
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528 // little-endian 28 b5 2f fd

/**
 * Locate every complete Zstandard frame in a concatenated-frame buffer.
 * @param {Buffer} buffer - raw artifact bytes.
 * @returns {{frames: {start: number, end: number}[], tornStart?: number}}
 *   complete frame ranges in order, plus the start of a trailing torn frame.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Iterate the JSON value on every non-empty line of a multi-frame JSONL buffer.
 * @param {Buffer} buffer - raw artifact bytes (Zstandard container).
 * @param {(value: unknown) => void} visit - called per parsed line, in order.
 * @returns {{lines: number, frames: number, truncated: boolean, tornStart?: number}}
 *   decode accounting; `truncated` marks a torn trailing frame (a live append).
 */
export function readZstdJsonl(buffer, visit) {
  const { frames, tornStart } = scanZstdFrames(buffer)
  let lines = 0
  for (const { start, end } of frames) {
    let text
    try {
      text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch (error) {
      throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, {
        cause: error,
      })
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      lines += 1
      visit(JSON.parse(line))
    }
  }
  return { lines, frames: frames.length, truncated: tornStart !== undefined, tornStart }
}
