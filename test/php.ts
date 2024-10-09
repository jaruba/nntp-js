import { NNTP } from '../src/index.ts'

const conn = new NNTP('news.php.net', 119)
await conn.connect()

console.log(await conn.date())

await conn.group('php.general')
console.log(await conn.article(23131))
console.log(await conn.head(23131))

conn.quit()
