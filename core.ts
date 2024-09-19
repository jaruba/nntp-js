import net from 'net'
import tls from 'tls'
import { EventEmitter } from 'events'
import { DateTime } from 'luxon'
import argparse from 'argparse'
import netrc from 'netrc'
import { decodeHeader } from './helpers.ts'
import { createInterface } from 'readline'

interface ArticleInfo {
  art_num: number
  message_id: string
  lines: string[]
}

interface GroupInfo {
  name: string
  high: number
  low: number
  status: string
}

interface File extends net.Socket { }

class NNTP extends EventEmitter {
  private host: string
  public port: number
  private sock: net.Socket
  private file: File | null
  private debugging: number
  private welcome: string
  private _caps: Record<string, string[]> | null
  private readermode_afterauth: boolean
  private tls_on: boolean
  private authenticated: boolean
  private nntp_version: number
  private nntp_implementation: string | null
  private _cachedoverviewfmt: string[] | null
  private lineReader: AsyncIterableIterator<string>
  ready: Promise<void>

  constructor (
    host: string,
    port: number = 119,
    user: string | null = null,
    password: string | null = null,
    readermode: boolean | null = null,
    usenetrc: boolean = false,
    timeout: number | undefined = undefined
  ) {
    super()
    this.host = host
    this.port = port
    this.sock = this._createSocket(timeout)
    this.file = null
    this.ready = (async () => {
      try {
        this.file = this.sock
        this.lineReader = createInterface({
          input: this.sock,
          crlfDelay: Infinity
        })[Symbol.asyncIterator]()
        await this._baseInit(readermode)
        if (user || usenetrc) {
          await this.login(user, password, usenetrc)
        }
      } catch (error) {
        if (this.file) {
          this.file.end()
        }
        this.sock.end()
        throw error
      }
    })()
  }

  private async _baseInit (readermode: boolean | null) {
    this.debugging = 1
    this.welcome = await this._getresp()
    this._caps = null
    await this.getcapabilities()
    this.readermode_afterauth = false
    if (readermode && !this._caps?.['READER']) {
      await this._setreadermode()
      if (!this.readermode_afterauth) {
        this._caps = null
        await this.getcapabilities()
      }
    }
    this.tls_on = false
    this.authenticated = false
  }

  protected _createSocket (timeout: number | undefined): net.Socket {
    if (timeout !== null && timeout === 0) {
      throw new Error("Non-blocking socket (timeout=0) is not supported")
    }
    return net.createConnection({ host: this.host, port: this.port, timeout })
  }

  private async _getresp (): Promise<string> {
    const resp = await this._getline()
    if (this.debugging) {
      console.log("*resp*", resp)
    }
    if (resp.startsWith('4')) {
      throw new Error(`NNTPTemporaryError: ${resp}`)
    }
    if (resp.startsWith('5')) {
      throw new Error(`NNTPPermanentError: ${resp}`)
    }
    if (!resp.startsWith('1') && !resp.startsWith('2') && !resp.startsWith('3')) {
      throw new Error(`NNTPProtocolError: ${resp}`)
    }
    return resp
  }

  private async _getline (): Promise<string> {
    let { value } = await this.lineReader.next()
    if (this.debugging > 1) {
      console.log("*get*", value)
    }
    if (!value) {
      throw new Error("EOFError")
    }
    return value.trim()
  }

  private _putline (line: string): void {
    if (this.debugging > 1) {
      console.log("*put*", line)
    }
    this.file?.write(line + '\r\n')
  }

  private _putcmd (line: string): void {
    if (this.debugging) {
      console.log("*cmd*", line)
    }
    this._putline(line)
  }

  private _shortcmd (line: string): Promise<string> {
    this._putcmd(line)
    return this._getresp()
  }

  private _longcmd (line: string, file: File | null = null): Promise<[string, string[]]> {
    this._putcmd(line)
    return this._getlongresp(file)
  }

  private async _getlongresp (file: File | null = null): Promise<[string, string[]]> {
    let openedFile: File | null = null
    try {
      if (file) {
        openedFile = file
      }
      const resp = await this._getresp()
      const lines: string[] = []
      if (file) {
        const terminators = ['.\r\n', '.\n']
        while (true) {
          let line = await this._getline()
          if (terminators.includes(line)) {
            break
          }
          if (line.startsWith('..')) {
            line = line.substring(1)
          }
          file.write(line)
        }
      } else {
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
      }
      return [resp, lines]
    } finally {
      if (openedFile) {
        openedFile.end()
      }
    }
  }

  public getwelcome (): string {
    if (this.debugging) {
      console.log("*welcome*", this.welcome)
    }
    return this.welcome
  }

  public async getcapabilities () {
    if (this._caps === null) {
      this.nntp_version = 1
      this.nntp_implementation = null
      try {
        const [resp, caps] = await this.capabilities()
        this._caps = caps
        if (caps['VERSION']) {
          this.nntp_version = Math.max(...caps['VERSION'].map(Number))
        }
        if (caps['IMPLEMENTATION']) {
          this.nntp_implementation = caps['IMPLEMENTATION'].join(' ')
        }
      } catch (error) {
        this._caps = {}
      }
    }
    return this._caps
  }

  public set_debuglevel (level: number): void {
    this.debugging = level
  }

  public debug (level: number): void {
    this.set_debuglevel(level)
  }

  public async capabilities (): Promise<[string, Record<string, string[]>]> {
    const caps: Record<string, string[]> = {}
    const [resp, lines] = await this._longcmdstring("CAPABILITIES")
    for (const line of lines) {
      const [name, ...tokens] = line.split(' ')
      caps[name] = tokens
    }
    return [resp, caps]
  }

  public newgroups (date: DateTime, file: File | null = null) {
    if (!(date instanceof DateTime)) {
      throw new TypeError("the date parameter must be a DateTime object")
    }
    const date_str = date.toFormat('yyyyMMdd')
    const time_str = date.toFormat('HHmmss')
    const cmd = `NEWGROUPS ${date_str} ${time_str}`
    return this._longcmdstring(cmd, file)
  }

  public newnews (group: string, date: DateTime, file: File | null = null) {
    if (!(date instanceof DateTime)) {
      throw new TypeError("the date parameter must be a DateTime object")
    }
    const date_str = date.toFormat('yyyyMMdd')
    const time_str = date.toFormat('HHmmss')
    const cmd = `NEWNEWS ${group} ${date_str} ${time_str}`
    return this._longcmdstring(cmd, file)
  }

  public list (group_pattern: string | null = null, file: File | null = null) {
    const command = group_pattern ? `LIST ACTIVE ${group_pattern}` : "LIST"
    return this._longcmdstring(command, file)
  }

  public async description (group: string) {
    return await this._getdescriptions(group, false) as string
  }

  public async descriptions (group_pattern: string) {
    return await this._getdescriptions(group_pattern, true) as [string, Record<string, string>]
  }

  public async group (name: string): Promise<[string, number, number, number, string]> {
    const resp = await this._shortcmd(`GROUP ${name}`)
    if (!resp.startsWith("211")) {
      throw new Error(`NNTReplyError: ${resp}`)
    }
    const words = resp.split(' ')
    const count = parseInt(words[1], 10)
    const first = parseInt(words[2], 10)
    const last = parseInt(words[3], 10)
    const groupName = words[4].toLowerCase()
    return [resp, count, first, last, groupName]
  }

  public help (file: File | null = null) {
    return this._longcmdstring("HELP", file)
  }

  public stat (message_spec: any = null) {
    if (message_spec) {
      return this._statcmd(`STAT ${message_spec}`)
    } else {
      return this._statcmd("STAT")
    }
  }

  public next () {
    return this._statcmd("NEXT")
  }

  public last () {
    return this._statcmd("LAST")
  }

  public head (message_spec: any = null, file: File | null = null) {
    const cmd = message_spec ? `HEAD ${message_spec}` : "HEAD"
    return this._artcmd(cmd, file)
  }

  public body (message_spec: any = null, file: File | null = null) {
    const cmd = message_spec ? `BODY ${message_spec}` : "BODY"
    return this._artcmd(cmd, file)
  }

  public article (message_spec: any = null, file: File | null = null) {
    const cmd = message_spec ? `ARTICLE ${message_spec}` : "ARTICLE"
    return this._artcmd(cmd, file)
  }

  public slave () {
    return this._shortcmd("SLAVE")
  }

  public async xhdr (hdr: string, str: any, file: File | null = null): Promise<[string, string[]]> {
    const pat = /^([0-9]+) ?(.*)\n?/
    const [resp, lines] = await this._longcmdstring(`XHDR ${hdr} ${str}`, file)
    return [resp, lines.map(line => {
      const match = pat.exec(line)
      return match ? match[1] : line
    })]
  }

  public async xover (start: number, end: number, file: File | null = null): Promise<[string, [number, Record<string, string>][]]> {
    const [resp, lines] = await this._longcmdstring(`XOVER ${start}-${end}`, file)
    const fmt = await this._getoverviewfmt()
    return [resp, this._parse_overview(lines, fmt)]
  }

  public async over (message_spec: any, file: File | null = null): Promise<[string, [number, Record<string, string>][]]> {
    let cmd = this._caps?.['OVER'] ? "OVER" : "XOVER"
    let start: number | null = null
    let end: number | null = null
    if (Array.isArray(message_spec)) {
      [start, end] = message_spec
      cmd += ` ${start}-${end || ''}`
    } else if (message_spec !== null) {
      cmd += ` ${message_spec}`
    }
    const [resp, lines] = await this._longcmdstring(cmd, file)
    const fmt = await this._getoverviewfmt()
    return [resp, this._parse_overview(lines, fmt)]
  }

  public async date (): Promise<[string, DateTime]> {
    const resp = await this._shortcmd("DATE")
    if (!resp.startsWith("111")) {
      throw new Error(`NNTReplyError: ${resp}`)
    }
    const elem = resp.split(' ')
    if (elem.length !== 2) {
      throw new Error(`NNTPDataError: ${resp}`)
    }
    const date = elem[1]
    if (date.length !== 14) {
      throw new Error(`NNTPDataError: ${resp}`)
    }
    return [resp, DateTime.fromFormat(date, 'yyyyMMddHHmmss')]
  }

  public post (data: Buffer | Iterable<Buffer>) {
    return this._post("POST", data)
  }

  public ihave (message_id: any, data: Buffer | Iterable<Buffer>) {
    return this._post(`IHAVE ${message_id}`, data)
  }

  public async quit () {
    try {
      const resp = await this._shortcmd("QUIT")
      this._close()
      return resp
    } finally {
      this._close()
    }
  }

  public async login (user: string | null = null, password: string | null = null, usenetrc: boolean = true) {
    if (this.authenticated) {
      throw new Error("Already logged in.")
    }
    if (!user && !usenetrc) {
      throw new Error("At least one of `user` and `usenetrc` must be specified")
    }
    try {
      if (usenetrc && !user) {
        const credentials = netrc()
        const auth = credentials.machines[this.host]
        if (auth) {
          user = auth.login
          password = auth.password
        }
      }
    } catch (error) {
      // Ignore netrc errors
    }
    if (!user) {
      return
    }
    let resp = await this._shortcmd(`authinfo user ${user}`)
    if (resp.startsWith("381")) {
      if (!password) {
        throw new Error(`NNTReplyError: ${resp}`)
      } else {
        resp = await this._shortcmd(`authinfo pass ${password}`)
        if (!resp.startsWith("281")) {
          throw new Error(`NNTPPermanentError: ${resp}`)
        }
      }
    }
    this._caps = null
    this.getcapabilities()
    if (this.readermode_afterauth && !this._caps?.['READER']) {
      this._setreadermode()
      this._caps = null
      this.getcapabilities()
    }
  }

  private async _setreadermode () {
    try {
      this.welcome = await this._shortcmd("mode reader")
    } catch (error) {
      if (error.message.startsWith("480")) {
        this.readermode_afterauth = true
      } else {
        throw error
      }
    }
  }

  private _close (): void {
    try {
      if (this.file) {
        this.file.end()
        this.file = null
      }
    } finally {
      this.sock.end()
    }
  }

  private _statparse (resp: string): [string, number, string] {
    if (!resp.startsWith("22")) {
      throw new Error(`NNTReplyError: ${resp}`)
    }
    const words = resp.split(' ')
    const art_num = parseInt(words[1], 10)
    const message_id = words[2]
    return [resp, art_num, message_id]
  }

  private async _statcmd (line: string): Promise<[string, number, string]> {
    const resp = await this._shortcmd(line)
    return this._statparse(resp)
  }

  private async _artcmd (line: string, file: File | null = null): Promise<[string, ArticleInfo]> {
    const [resp, lines] = await this._longcmd(line, file)
    const [, art_num, message_id] = this._statparse(resp)
    return [resp, { art_num, message_id, lines }]
  }

  private async _getoverviewfmt () {
    if (this._cachedoverviewfmt) {
      return this._cachedoverviewfmt
    }
    try {
      const [resp, lines] = await this._longcmdstring("LIST OVERVIEW.FMT")
      this._cachedoverviewfmt = this._parse_overview_fmt(lines)
    } catch (error) {
      this._cachedoverviewfmt = ["Subject", "From", "Date", "Message-ID", "References", "Bytes", "Lines"]
    }
    return this._cachedoverviewfmt
  }

  private _parse_overview_fmt (lines: string[]): string[] {
    return lines.map(line => line.trim())
  }

  private _parse_overview (lines: string[], fmt: string[]): [number, Record<string, string>][] {
    return lines.map(line => {
      const parts = line.split('\t')
      const overview: Record<string, string> = {}
      for (let i = 0; i < fmt.length; i++) {
        overview[fmt[i]] = parts[i]
      }
      return [parseInt(parts[0], 10), overview]
    })
  }

  private async _longcmdstring (line: string, file: File | null = null): Promise<[string, string[]]> {
    const [resp, lines] = await this._longcmd(line, file)
    return [resp, lines.map(line => line.toString())]
  }

  private async _getdescriptions (group_pattern: string, return_all: boolean): Promise<string | [string, Record<string, string>]> {
    const line_pat = /^(?<group>[^ \t]+)[ \t]+(.*)$/
    const [resp, lines] = await this._longcmdstring(`LIST NEWSGROUPS ${group_pattern}`)
    if (!resp.startsWith("215")) {
      const [resp2, lines2] = await this._longcmdstring(`XGTITLE ${group_pattern}`)
      if (return_all) {
        const groups: Record<string, string> = {}
        for (const raw_line of lines2) {
          const match = line_pat.exec(raw_line.trim())
          if (match) {
            const [, name, desc] = match
            groups[name] = desc
          }
        }
        return [resp2, groups]
      } else {
        return ""
      }
    } else {
      if (return_all) {
        const groups: Record<string, string> = {}
        for (const raw_line of lines) {
          const match = line_pat.exec(raw_line.trim())
          if (match) {
            const [, name, desc] = match
            groups[name] = desc
          }
        }
        return [resp, groups]
      } else {
        const match = line_pat.exec(lines[0].trim())
        if (match) {
          const [, , desc] = match
          return desc
        }
        return ""
      }
    }
  }

  private async _post (command: string, data: Buffer | Iterable<Buffer>) {
    const resp = await this._shortcmd(command)
    if (!resp.startsWith("3")) {
      throw new Error(`NNTReplyError: ${resp}`)
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
      this.file?.write(lineStr)
    }
    this.file?.write('.\r\n')
    return await this._getresp()
  }

  public async starttls (context: tls.SecureContext | undefined = undefined) {
    if (this.tls_on) {
      throw new Error("TLS is already enabled.")
    }
    if (this.authenticated) {
      throw new Error("TLS cannot be started after authentication.")
    }
    const resp = await this._shortcmd("STARTTLS")
    if (resp.startsWith("382")) {
      // console.log({ host: this.host, port: NNTP_SSL_PORT, secureContext: context })
      await new Promise<void>((resolve, reject) => {
        this.file = this.sock = tls.connect(5000, this.host, { socket: this.sock }, () => {
          resolve()
        })
      })
      this.lineReader = createInterface({
        input: this.sock,
        crlfDelay: Infinity
      })[Symbol.asyncIterator]()
      this.tls_on = true
      this._caps = null
      await this.getcapabilities()
    } else {
      throw new Error("TLS failed to start.")
    }
  }
}

const NNTP_PORT = 119
const NNTP_SSL_PORT = 563

class NNTP_SSL extends NNTP {
  private ssl_context: tls.SecureContextOptions | undefined

  constructor (
    host: string,
    port: number = NNTP_SSL_PORT,
    user: string | null = null,
    password: string | null = null,
    ssl_context: tls.SecureContextOptions | undefined = undefined,
    readermode: boolean | null = null,
    usenetrc: boolean = false,
    timeout: number | undefined = undefined,
  ) {
    super(host, port, user, password, readermode, usenetrc, timeout)
    this.ssl_context = ssl_context
  }

  protected _createSocket (timeout: number | undefined): tls.TLSSocket {
    const sock = super._createSocket(timeout)
    try {
      return new tls.TLSSocket(sock, this.ssl_context)
    } catch (error) {
      sock.destroy()
      throw error
    }
  }
}

if (true) {
  const parser = new argparse.ArgumentParser({
    description: "nntp built-in demo - display the latest articles in a newsgroup"
  })

  parser.add_argument("-g", "--group", {
    default: "gmane.comp.python.general",
    help: "group to fetch messages from (default: %(default)s)"
  })
  parser.add_argument("-s", "--server", {
    default: "news.gmane.io",
    help: "NNTP server hostname (default: %(default)s)"
  })
  parser.add_argument("-p", "--port", {
    default: -1,
    type: "int",
    help: `NNTP port number (default: ${NNTP_PORT} / ${NNTP_SSL_PORT})`
  })
  parser.add_argument("-n", "--nb-articles", {
    default: 10,
    type: "int",
    help: "number of articles to fetch (default: %(default)s)"
  })
  parser.add_argument("-S", "--ssl", {
    action: "store_true",
    default: false,
    help: "use NNTP over SSL"
  })

  const args = parser.parse_args()

  let port = args.port
  let s: NNTP | NNTP_SSL

  if (!args.ssl) {
    if (port === -1) {
      port = NNTP_PORT
    }
    s = new NNTP(args.server, port)
  } else {
    if (port === -1) {
      port = NNTP_SSL_PORT
    }
    s = new NNTP_SSL(args.server, port)
  }

  await s.ready

  const caps = await s.getcapabilities()
  if ("STARTTLS" in caps) {
    await s.starttls()
  }

  const [resp, count, first, last, name] = await s.group(args.group)
  console.log("Group", name, "has", count, "articles, range", first, "to", last)

  function cut (s: string, lim: number): string {
    if (s.length > lim) {
      return s.slice(0, lim - 4) + "..."
    }
    return s
  }

  const firstArticle = String((last | 0) - args.nb_articles + 1)
  const [, overviews] = await s.xover(parseInt(firstArticle), last)

  for (const [artnum, over] of overviews) {
    const author = decodeHeader(over["From:"]).split("<", 1)[0]
    const subject = decodeHeader(over["Subject:"])
    const lines = parseInt(over["Lines:"])
    console.log(`${artnum.toString().padStart(7)} ${cut(author, 20).padEnd(20)} ${cut(subject, 42).padEnd(42)} (${lines})`)
  }

  s.quit()
}
