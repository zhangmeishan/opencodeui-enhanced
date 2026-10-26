import { describe, expect, it } from 'vitest'
import { getFileLinkPath } from './fileLinks'

describe('workspace file links', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['./output/报告%20最终.docx', './output/报告 最终.docx'],
    ['/workspace/report.zip', '/workspace/report.zip'],
    ['sandbox:/mnt/data/report.xlsx', '/mnt/data/report.xlsx'],
    ['file:///workspace/%E6%8A%A5%E5%91%8A.pdf', '/workspace/报告.pdf'],
    ['file:///C:/output/report.pdf', 'C:/output/report.pdf'],
    ['C:\\output\\report.pdf', 'C:\\output\\report.pdf'],
    ['src/app.ts#L10-L20', 'src/app.ts'],
    ['C:\\output\\report.ts#L10-L20', 'C:\\output\\report.ts'],
    ['#opencode-local-file:C%3A%5Coutput%5Creport.ts%23L10', 'C:\\output\\report.ts'],
  ])('resolves %s', (href, path) => expect(getFileLinkPath(href)).toBe(path))

  it.each([
    'https://example.com/file.pdf',
    '//example.com/file.pdf',
    'mailto:user@example.com',
    '#fn-1',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'file://remote/report.pdf',
    '%broken',
    '?query=1',
    'file:///workspace/bad%00.txt',
    '#opencode-local-file:bad%0A.txt',
    'C:\\output\\bad%00.txt',
  ])('leaves non-file or invalid links alone: %s', href => {
    expect(getFileLinkPath(href)).toBeNull()
  })
})
