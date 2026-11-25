#!/usr/bin/env node
// Import a card file into the running Tavern's library, through the same upload path as the UI's 导入人物卡.
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CARD_ARCHIVE_CHUNK_BYTES, MAX_CARD_UPLOAD_BYTES } from '../tavern-plugin/lib/domain/uploads.js'
import { connectTavern } from './update-library-card.mjs'

export async function importLibraryCard({ url, file, password, accessPin, fetchImpl = fetch }) {
  const name = basename(file)
  if (!/\.(json|png|charx|dshcard)$/i.test(name)) throw new Error('支持 JSON、PNG、CHARX 和 DSHCARD')
  const info = await stat(file)
  if (!info.isFile() || !info.size) throw new Error('请指定非空人物卡文件')
  if (info.size > MAX_CARD_UPLOAD_BYTES) throw new Error('人物卡超过 ' + MAX_CARD_UPLOAD_BYTES / 1024 ** 3 + ' GiB')
  const request = await connectTavern({ url, accessPin, fetchImpl })
  const chunked = /\.(charx|dshcard)$/i.test(name) && info.size > 1024 ** 3
  const chunkSize = chunked ? CARD_ARCHIVE_CHUNK_BYTES : info.size
  let uploadId, result
  try {
    for (let offset = 0; offset < info.size; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, info.size)
      const query = chunked ? { purpose: 'card-archive', size: info.size, offset, ...(uploadId ? { uploadId } : {}) } : undefined
      const stream = createReadStream(file, { start: offset, end: end - 1 })
      try {
        const reply = await request('card-upload', stream, { length: end - offset, query })
        uploadId = reply.uploadId
        if (reply.size !== end) throw new Error('人物卡上传进度不一致，请重新导入')
      } finally { stream.destroy() }
    }
    result = await request('importCardUpload', { uploadId, name, ...(password ? { password } : {}) })
  } finally {
    if (uploadId) await request('discardCardUpload', { uploadId }).catch(() => {})
  }
  if (!result.card?.path) throw new Error('运行中的本体没有返回导入后的卡路径')
  return result.card
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = process.argv.slice(2)
  if (!files.length || !process.env.DSH_TAVERN_URL) {
    console.error('用法：设置 DSH_TAVERN_URL 为 dsh-tavern status 显示的完整访问地址，再运行 node bin/import-library-card.mjs 人物卡.json [更多文件…]。桌面访问密码通过 DSH_TAVERN_ACCESS_PIN、加密卡密码通过 DSH_CARD_PASSWORD 传入。不会启动其他服务。')
    process.exitCode = 1
  } else {
    for (const file of files) {
      try {
        const card = await importLibraryCard({ url: process.env.DSH_TAVERN_URL, file: resolve(file), password: process.env.DSH_CARD_PASSWORD, accessPin: process.env.DSH_TAVERN_ACCESS_PIN })
        console.log(JSON.stringify({ file, path: card.path, name: card.name, duplicate: card.duplicate === true, assets: card.assets, notices: card.libraryNotices }, null, 2))
      } catch (error) { console.error(file + '：' + String(error.message).replace(/([?&]token=)[^\s&]+/g, '$1<redacted>')); process.exitCode = 1 }
    }
  }
}
