import { describe, expect, it, vi } from 'vitest'
import { createProgressReporter, readResponseBytes, transferPercent } from './transferProgress'

describe('transfer progress', () => {
  it('keeps final processing below 100% and only reports 100 after success', () => {
    expect(transferPercent({ loaded: 100, total: 100, phase: 'processing' })).toBe(99)
    expect(transferPercent({ loaded: 0, total: 0, phase: 'completed' })).toBe(100)
    expect(transferPercent({ loaded: 25, total: 100, phase: 'transferring' })).toBe(25)
    expect(transferPercent({ loaded: 25, phase: 'transferring' })).toBeUndefined()
  })
  it('coalesces frequent byte updates while delivering all stage transitions', () => {
    const callback = vi.fn()
    const report = createProgressReporter(callback)
    report({ loaded: 0, total: 100, phase: 'transferring' })
    for (let index = 1; index < 100; index++) report({ loaded: index, total: 100, phase: 'transferring' })
    report({ loaded: 100, total: 100, phase: 'processing' })
    report({ loaded: 100, total: 100, phase: 'completed' })
    expect(callback).toHaveBeenCalledTimes(3)
    expect(callback.mock.calls.at(-1)?.[0].phase).toBe('completed')
  })
  it('counts streamed HTTP bytes and retains binary content', async () => {
    const callback = vi.fn()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 255]))
          controller.enqueue(new Uint8Array([1, 2, 3]))
          controller.close()
        },
      }),
      { headers: { 'content-length': '5' } },
    )
    expect(await readResponseBytes(response, callback)).toEqual(new Uint8Array([0, 255, 1, 2, 3]))
    expect(callback.mock.calls[0][0]).toEqual({ loaded: 0, total: 5, phase: 'transferring' })
    expect(callback.mock.calls.at(-1)?.[0]).toEqual({ loaded: 5, total: 5, phase: 'processing' })
  })
  it('does not use compressed content length for decompressed stream percentages', async () => {
    const callback = vi.fn()
    await readResponseBytes(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '2', 'content-encoding': 'gzip' } }),
      callback,
    )
    expect(callback.mock.calls[0][0].total).toBeUndefined()
  })
})
