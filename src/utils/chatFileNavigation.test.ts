import { describe, expect, it } from 'vitest'
import { resolveChatFile } from './chatFileNavigation'

describe('chat file path resolution', () => {
  it('resolves encoded relative paths against the originating conversation directory', () => {
    expect(
      resolveChatFile('./output/报告%20最终.docx', '/home/masonzms/qiujing-thesis', 'masonzms', '/home/masonzms'),
    ).toEqual({
      path: 'output/报告 最终.docx',
      name: '报告 最终.docx',
      directory: '/home/masonzms/qiujing-thesis',
      serverId: 'masonzms',
    })
  })
  it('uses a root-relative preview for an absolute file outside the chat project but inside the server root', () => {
    expect(
      resolveChatFile('file:///workspace/shared/report.pdf', '/workspace/project', 'remote', '/workspace'),
    ).toMatchObject({ path: 'shared/report.pdf', directory: '/workspace', serverId: 'remote' })
  })
  it('normalizes Windows paths and preserves source line navigation', () => {
    expect(resolveChatFile('C:\\Work\\Thesis\\src\\main.ts#L10', 'c:/work/thesis', 'windows', 'C:/Work')).toMatchObject(
      { path: 'src/main.ts', directory: 'c:/work/thesis', targetLine: 10 },
    )
  })
  it.each([
    '/etc/passwd',
    '../../outside.txt',
    'https://example.com/report.pdf',
    '#chapter',
    'file://remote/file.txt',
    'notes%00.txt',
  ])('rejects invalid or outside-workspace targets: %s', href => {
    expect(() => resolveChatFile(href, '/workspace/project', 'remote', '/workspace')).toThrow()
  })
})
