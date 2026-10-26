import { describe, expect, it } from 'vitest'
import { isSameDirectory, normalizeToForwardSlash } from './directoryUtils'

describe('cross-platform directory comparison', () => {
  it('preserves filesystem root directories', () => {
    expect(normalizeToForwardSlash('/')).toBe('/')
    expect(normalizeToForwardSlash('C:\\')).toBe('C:/')
    expect(isSameDirectory('/', '')).toBe(false)
  })
  it('keeps Linux projects case sensitive while accepting Windows case and separators', () => {
    expect(isSameDirectory('/home/masonzms/qiujing-thesis', '/home/masonzms/Qiujing-thesis')).toBe(false)
    expect(isSameDirectory('/home/masonzms/qiujing-thesis/', '/home/masonzms/qiujing-thesis')).toBe(true)
    expect(isSameDirectory('C:\\Work\\Thesis\\', 'c:/work/thesis')).toBe(true)
    expect(isSameDirectory('\\\\Server\\Share\\Thesis', '//server/share/thesis')).toBe(true)
  })
})
