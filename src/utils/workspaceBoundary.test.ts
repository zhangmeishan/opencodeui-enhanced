import { describe, expect, it } from 'vitest'
import { isWithinWorkspace, isProjectFilePath } from './workspaceBoundary'

describe('workspace navigation boundaries', () => {
  it.each([
    ['/repo', '/repo', true],
    ['/repo/src', '/repo', true],
    ['/repo-other', '/repo', false],
    ['/repo/../outside', '/repo', false],
    ['/repo/src/../docs', '/repo', true],
    ['C:\\Repo\\src', 'c:/repo', true],
    ['D:/repo/src', 'C:/repo', false],
    ['/Repo/src', '/repo', false],
    ['/etc', '/', true],
    ['relative', '/repo', false],
  ])('compares %s within %s', (path, root, expected) => expect(isWithinWorkspace(path, root)).toBe(expected))
  it('rejects relative traversal and absolute paths outside a project', () => {
    expect(isProjectFilePath('../outside.txt', '/repo')).toBe(false)
    expect(isProjectFilePath('/etc/passwd', '/repo')).toBe(false)
    expect(isProjectFilePath('src/main.py', '/repo')).toBe(true)
  })
})
