import net from 'node:net'
import tls from 'node:tls'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'events'
import { formatDate, parseDateString, parseHeaders, parseOverview, parseOverviewFmt } from './helpers.ts'
import { NNTPDataError, NNTPPermanentError, NNTPProtocolError, NNTPReplyError, NNTPTemporaryError } from './exceptions.ts'
import { DEFAULT_OVERVIEW_FMT, LONGRESP } from './constants.ts'

interface ArticleInfo {
  artNum: number
  messageId: string
  lines: string[]
}

export class NNTP extends EventEmitter {
  host
  port
  sock?: net.Socket
  welcome?: string
  _caps?: Record<string, string[]>
  readermodeAfterauth?: boolean
  tlsOn = false
  authenticated = false
  nntpVersion?: number
  nntpImplementation?: string
  _cachedoverviewfmt?: string[]
  lineReader?: AsyncIterableIterator<string>
  connected = false

  constructor (host: string, port = 119, readermode = false, timeout?: number) {
    super()
    this.host = host
    this.port = port
  }

  async connect (readermode = false, timeout: number | undefined = undefined, socket?: net.Socket) {
    try {
      this.sock = socket || this._createSocket(timeout)
      this.lineReader = createInterface({
        input: this.sock,
        crlfDelay: Infinity

      })[Symbol.asyncIterator]()
      this.welcome = await this._getresp()
      this._caps = undefined
      await this.getcapabilities()
      this.readermodeAfterauth = false
      if (readermode && !this._caps!?.READER) {
        await this._setreadermode()
        if (!this.readermodeAfterauth) {
          this._caps = undefined
          await this.getcapabilities()
        }
      }
      this.connected = true
    } catch (error) {
      this.sock?.end()
      throw error
    }
  }

  connectTLS (readermode = false, timeout?: number, context?: tls.SecureContext) {
    return this.connect(readermode, 0, new tls.TLSSocket(this._createSocket(timeout), { secureContext: context }))
  }

  _createSocket (timeout?: number) {
    if (timeout != null && timeout === 0) {
      throw new Error('Non-blocking socket (timeout=0) is not supported')
    }
    return net.createConnection({ host: this.host, port: this.port, timeout })
  }

  async _getresp (): Promise<string> {
    const resp = await this._getline()
    if (resp.startsWith('4')) {
      throw new NNTPTemporaryError(resp)
    }
    if (resp.startsWith('5')) {
      throw new NNTPPermanentError(resp)
    }
    if (!resp.startsWith('1') && !resp.startsWith('2') && !resp.startsWith('3')) {
      throw new NNTPProtocolError(resp)
    }
    return resp
  }

  async _getline (): Promise<string> {
    const { value } = await this.lineReader!.next()
    if (value === undefined) throw new Error('End of stream')

    return value.trim()
  }

  _putline (line: string) {
    if (!this.connected) throw new Error('Not connected')
    this.sock!.write(line + '\r\n')
  }

  _putcmd (line: string) {
    this._putline(line)
  }

  _shortcmd (line: string) {
    this._putcmd(line)
    return this._getresp()
  }

  _longcmd (line: string): Promise<[string, string[]]> {
    this._putcmd(line)
    return this._getlongresp()
  }

  async _getlongresp (): Promise<[string, string[]]> {
    const resp = await this._getresp()
    if (!LONGRESP.has(resp.slice(0, 3))) throw new NNTPReplyError(resp)
    const lines: string[] = []

    const terminator = '.'
    while (true) {
      let line = await this._getline()
      if (line === terminator) {
        break
      }
      if (line.startsWith('..')) {
        line = line.substring(1)
      }
      lines.push(line)
    }

    return [resp, lines]
  }

  getwelcome (): string {
    return this.welcome as string
  }

  async getcapabilities () {
    if (this._caps === undefined) {
      this.nntpVersion = 1
      this.nntpImplementation = undefined
      try {
        const [, caps] = await this.capabilities()
        this._caps = caps
        if (caps.VERSION) {
          this.nntpVersion = Math.max(...caps.VERSION.map(Number))
        }
        if (caps.IMPLEMENTATION) {
          this.nntpImplementation = caps.IMPLEMENTATION.join(' ')
        }
      } catch (error) {
        this._caps = {}
      }
    }
    return this._caps
  }

  async capabilities (): Promise<[string, Record<string, string[]>]> {
    const caps: Record<string, string[]> = {}
    const [resp, lines] = await this._longcmdstring('CAPABILITIES')
    for (const line of lines) {
      const [name, ...tokens] = line.split(' ')
      caps[name] = tokens
    }
    return [resp, caps]
  }

  newgroups (date: Date) {
    if (!(date instanceof Date)) {
      throw new TypeError('the date parameter must be a Date object')
    }

    return this._longcmdstring(`NEWGROUPS ${formatDate(date, 'yyyyMMdd')} ${formatDate(date, 'HHmmss')}`)
  }

  newnews (group: string, date: Date) {
    if (!(date instanceof Date)) {
      throw new TypeError('the date parameter must be a Date object')
    }

    return this._longcmdstring(`NEWNEWS ${group} ${formatDate(date, 'yyyyMMdd')} ${formatDate(date, 'HHmmss')}`)
  }

  list (groupPattern: string | null = null) {
    const command = groupPattern ? `LIST ACTIVE ${groupPattern}` : 'LIST'
    return this._longcmdstring(command)
  }

  async description (group: string) {
    return await this._getdescriptions(group, false) as string
  }

  async descriptions (groupPattern: string) {
    return await this._getdescriptions(groupPattern, true) as [string, Record<string, string>]
  }

  async group (name: string): Promise<[string, number, number, number, string]> {
    const resp = await this._shortcmd(`GROUP ${name}`)
    if (!resp.startsWith('211')) {
      throw new NNTPReplyError(resp)
    }
    const words = resp.split(' ')
    const count = parseInt(words[1], 10)
    const first = parseInt(words[2], 10)
    const last = parseInt(words[3], 10)
    const groupName = words[4].toLowerCase()
    return [resp, count, first, last, groupName]
  }

  help () {
    return this._longcmdstring('HELP')
  }

  stat (messageSpec: string = '') {
    if (messageSpec) {
      return this._statcmd(`STAT ${messageSpec}`)
    } else {
      return this._statcmd('STAT')
    }
  }

  next () {
    return this._statcmd('NEXT')
  }

  last () {
    return this._statcmd('LAST')
  }

  /** get article head  */
  async head (messageSpec: number) {
    const cmd = messageSpec ? `HEAD ${messageSpec}` : 'HEAD'
    const [resp, art] = await this._artcmd(cmd)
    return [resp, parseHeaders(art.lines)]
  }

  /** get article body  */
  async body (messageSpec: number) {
    const cmd = messageSpec ? `BODY ${messageSpec}` : 'BODY'
    const [resp, art] = await this._artcmd(cmd)
    return [resp, art.lines.join()]
  }

  /** get article head and body  */
  async article (messageSpec?: number) {
    const cmd = messageSpec ? `ARTICLE ${messageSpec}` : 'ARTICLE'
    const [resp, art] = await this._artcmd(cmd)
    const lines: string[] = []
    let headers: Headers | undefined
    for (const line of art.lines) {
      if (!headers && line === '') {
        headers = parseHeaders(lines)
        lines.length = 0
      } else {
        lines.push(line)
      }
    }

    return [resp, { headers, body: lines.join('\r\n') }]
  }

  slave () {
    return this._shortcmd('SLAVE')
  }

  async xhdr (hdr: string, str: any): Promise<[string, string[]]> {
    const pat = /^([0-9]+) ?(.*)\n?/
    const [resp, lines] = await this._longcmdstring(`XHDR ${hdr} ${str}`)
    return [resp, lines.map(line => {
      const match = pat.exec(line)
      return match ? match[1] : line
    })]
  }

  async xover (start: number, end: number): Promise<[string, [number, Record<string, string>][]]> {
    const [resp, lines] = await this._longcmdstring(`XOVER ${start}-${end}`)
    const fmt = await this._getoverviewfmt()
    return [resp, parseOverview(lines, fmt)]
  }

  async over (messageSpec: any): Promise<[string, [number, Record<string, string>][]]> {
    let cmd = this._caps?.OVER ? 'OVER' : 'XOVER'
    let start: number | null = null
    let end: number | null = null
    if (Array.isArray(messageSpec)) {
      [start, end] = messageSpec
      cmd += ` ${start}-${end || ''}`
    } else if (messageSpec !== null) {
      cmd += ` ${messageSpec}`
    }
    const [resp, lines] = await this._longcmdstring(cmd)
    const fmt = await this._getoverviewfmt()
    return [resp, parseOverview(lines, fmt)]
  }

  async date (): Promise<[string, Date]> {
    const resp = await this._shortcmd('DATE')
    if (!resp.startsWith('111')) {
      throw new NNTPReplyError(resp)
    }
    const elem = resp.split(' ')
    if (elem.length !== 2) {
      throw new NNTPDataError(resp)
    }
    const date = elem[1]
    if (date.length !== 14) {
      throw new NNTPDataError(resp)
    }
    return [resp, parseDateString(date)]
  }

  post (data: Buffer | Iterable<Buffer>) {
    return this._post('POST', data)
  }

  ihave (messageId: any, data: Buffer | Iterable<Buffer>) {
    return this._post(`IHAVE ${messageId}`, data)
  }

  async quit () {
    try {
      const resp = await this._shortcmd('QUIT')
      this._close()
      return resp
    } finally {
      this._close()
    }
  }

  async login (user: string | null = null, password: string | null = null) {
    if (this.authenticated) {
      throw new Error('Already logged in.')
    }
    if (!user) {
      throw new Error('`user` must be specified')
    }

    let resp = await this._shortcmd(`authinfo user ${user}`)
    if (resp.startsWith('381')) {
      if (!password) {
        throw new NNTPReplyError(resp)
      } else {
        resp = await this._shortcmd(`authinfo pass ${password}`)
        if (!resp.startsWith('281')) {
          throw new NNTPPermanentError(resp)
        }
      }
    }
    this._caps = undefined
    this.getcapabilities()
    if (this.readermodeAfterauth && !this._caps!?.READER) {
      this._setreadermode()
      this._caps = undefined
      this.getcapabilities()
    }
  }

  async _setreadermode () {
    try {
      this.welcome = await this._shortcmd('mode reader')
    } catch (error) {
      if ((error as Error).message.startsWith('480')) {
        this.readermodeAfterauth = true
      } else {
        throw error
      }
    }
  }

  _close () {
    this.sock!.end()
  }

  _statparse (resp: string): [string, number, string] {
    if (!resp.startsWith('22')) {
      throw new NNTPReplyError(resp)
    }
    const words = resp.split(' ')
    const artNum = parseInt(words[1], 10)
    const messageId = words[2]
    return [resp, artNum, messageId]
  }

  async _statcmd (line: string) {
    const resp = await this._shortcmd(line)
    return this._statparse(resp)
  }

  async _artcmd (line: string): Promise<[string, ArticleInfo]> {
    const [resp, lines] = await this._longcmd(line)
    const [, artNum, messageId] = this._statparse(resp)
    return [resp, { artNum, messageId, lines }]
  }

  async _getoverviewfmt () {
    if (this._cachedoverviewfmt) {
      return this._cachedoverviewfmt
    }

    let fmt = []
    try {
      const [, lines] = await this._longcmdstring('LIST OVERVIEW.FMT')
      fmt = lines
    } catch (error) {
      fmt = DEFAULT_OVERVIEW_FMT
    }
    this._cachedoverviewfmt = parseOverviewFmt(fmt)
    return this._cachedoverviewfmt
  }

  async _longcmdstring (line: string): Promise<[string, string[]]> {
    const [resp, lines] = await this._longcmd(line)
    return [resp, lines]
  }

  async _getdescriptions (groupPattern: string, returnAll: boolean): Promise<string | [string, Record<string, string>]> {
    const linePat = /^(?<group>[^ \t]+)[ \t]+(.*)$/
    const [resp, lines] = await this._longcmdstring(`LIST NEWSGROUPS ${groupPattern}`)
    if (!resp.startsWith('215')) {
      const [resp2, lines2] = await this._longcmdstring(`XGTITLE ${groupPattern}`)
      if (returnAll) {
        const groups: Record<string, string> = {}
        for (const rawLine of lines2) {
          const match = linePat.exec(rawLine.trim())
          if (match) {
            const [, name, desc] = match
            groups[name] = desc
          }
        }
        return [resp2, groups]
      } else {
        return ''
      }
    } else {
      if (returnAll) {
        const groups: Record<string, string> = {}
        for (const rawLine of lines) {
          const match = linePat.exec(rawLine.trim())
          if (match) {
            const [, name, desc] = match
            groups[name] = desc
          }
        }
        return [resp, groups]
      } else {
        const match = linePat.exec(lines[0].trim())
        if (match) {
          const [, , desc] = match
          return desc
        }
        return ''
      }
    }
  }

  async _post (command: string, data: Buffer | Iterable<Buffer>) {
    const resp = await this._shortcmd(command)
    if (!resp.startsWith('3')) {
      throw new NNTPReplyError(resp)
    }
    if (data instanceof Buffer) {
      data = [data]
    }
    for (const line of data) {
      let lineStr = line.toString()
      if (!lineStr.endsWith('\r\n')) {
        lineStr += '\r\n'
      }
      if (lineStr.startsWith('.')) {
        lineStr = '.' + lineStr
      }
      this.sock!.write(lineStr)
    }
    this.sock!.write('.\r\n')
    return await this._getresp()
  }

  async starttls (secureContext?: tls.SecureContext) {
    if (this.tlsOn) {
      throw new Error('TLS is already enabled.')
    }
    if (this.authenticated) {
      throw new Error('TLS cannot be started after authentication.')
    }
    const resp = await this._shortcmd('STARTTLS')
    if (resp.startsWith('382')) {
      this.connected = false
      await new Promise<void>((resolve, reject) => {
        this.sock = tls.connect(5000, this.host, { socket: this.sock, secureContext }, () => {
          resolve()
        })
      })
      this.connected = true
      this.tlsOn = true
      this._caps = undefined
      await this.getcapabilities()
    } else {
      throw new Error('TLS failed to start.')
    }
  }
}
