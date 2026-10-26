import { describe, expect, it } from 'vitest'
import { matchesSessionDirectory } from './sessionScope'

describe('session directory identity', () => {
  it('keeps Linux case, directory boundaries, user and project names distinct', () => {
    const path = '/home/masonzms/qiujing-thesis'
    expect(matchesSessionDirectory(`${path}/`, path)).toBe(true)
    expect(matchesSessionDirectory(`${path}/../qiujing-thesis`, path)).toBe(true)
    for (const other of [
      undefined,
      `${path}-backup`,
      `${path}/subproject`,
      '/home/masonzms/Qiujing-thesis',
      '/home/other/qiujing-thesis',
    ])
      expect(matchesSessionDirectory(other, path)).toBe(false)
    expect(matchesSessionDirectory(undefined, undefined)).toBe(false)
  })
  it('normalizes Windows paths without treating a child folder as the parent project', () => {
    expect(matchesSessionDirectory('C:\\Work\\Thesis\\', 'c:/work/thesis')).toBe(true)
    expect(matchesSessionDirectory('C:\\Work\\Thesis2', 'c:/work/thesis')).toBe(false)
    expect(matchesSessionDirectory('C:\\Work\\Thesis\\child', 'c:/work/thesis')).toBe(false)
  })
})
