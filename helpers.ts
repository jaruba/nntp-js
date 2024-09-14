import { DateTime } from 'luxon'
import * as net from 'net'
import * as tls from 'tls'

// Importing constants and custom exceptions (assuming they are defined elsewhere)
import { DEFAULT_OVERVIEW_FMT, OVERVIEW_FMT_ALTERNATIVES } from './constants.ts'
import { NNTPDataError } from './exceptions.ts'

// // Helper function(s)
// function decodeHeader(headerStr) {
//     const parts = [];
//     const decodedHeader = require('libmime').decodeWords(headerStr);
//     parts.push(decodedHeader);
//     return parts.join('');
//   }

// Helper function(s)
export function decodeHeader (headerStr: string): string {
    // This is a simplified version. You might need a more robust header decoding library for TypeScript
    return headerStr
}

export function parseOverviewFmt (lines: string[]): string[] {
    const fmt: string[] = []
    for (const line of lines) {
        let name: string
        if (line[0] === ':') {
            // Metadata name (e.g. ":bytes")
            [name] = line.slice(1).split(':')
            name = ':' + name
        } else {
            // Header name (e.g. "Subject:" or "Xref:full")
            [name] = line.split(':')
        }
        name = name.toLowerCase()
        name = OVERVIEW_FMT_ALTERNATIVES[name] || name
        fmt.push(name)
    }
    const defaults = DEFAULT_OVERVIEW_FMT
    if (fmt.length < defaults.length) {
        throw new NNTPDataError("LIST OVERVIEW.FMT response too short")
    }
    if (!fmt.slice(0, defaults.length).every((v, i) => v === defaults[i])) {
        throw new NNTPDataError("LIST OVERVIEW.FMT redefines default fields")
    }
    return fmt
}

export function parseOverview (lines: string[], fmt: string[]): [number, { [key: string]: any }][] {
    const nDefaults = DEFAULT_OVERVIEW_FMT.length
    const overview: [number, { [key: string]: any }][] = []
    for (const line of lines) {
        const fields: { [key: string]: any } = {}
        const [articleNumberStr, ...tokens] = line.split('\t')
        const articleNumber = parseInt(articleNumberStr, 10)
        for (let i = 0; i < tokens.length; i++) {
            if (i >= fmt.length) {
                continue
            }
            const fieldName = fmt[i]
            const isMetadata = fieldName.startsWith(':')
            if (i >= nDefaults && !isMetadata) {
                const h = fieldName + ': '
                if (tokens[i] && tokens[i].toLowerCase().slice(0, h.length) !== h) {
                    throw new NNTPDataError("OVER/XOVER response doesn't include names of additional headers")
                }
               if (tokens[i]) tokens[i] = tokens[i].slice(h.length)
            }
            fields[fmt[i]] = tokens[i]
        }
        overview.push([articleNumber, fields])
    }
    return overview
}

export function parseDateTime (dateStr: string, timeStr?: string): DateTime {
    if (!timeStr) {
        timeStr = dateStr.slice(-6)
        dateStr = dateStr.slice(0, -6)
    }
    const hours = parseInt(timeStr.slice(0, 2), 10)
    const minutes = parseInt(timeStr.slice(2, 4), 10)
    const seconds = parseInt(timeStr.slice(4), 10)
    let year = parseInt(dateStr.slice(0, -4), 10)
    const month = parseInt(dateStr.slice(-4, -2), 10)
    const day = parseInt(dateStr.slice(-2), 10)
    // RFC 3977 doesn't say how to interpret 2-char years.  Assume that
    // there are no dates before 1970 on Usenet.
    if (year < 70) {
        year += 2000
    } else if (year < 100) {
        year += 1900
    }
    return DateTime.fromObject({ year, month, day, hour: hours, minute: minutes, second: seconds })
}

export function unparseDateTime (dt: DateTime, legacy: boolean = false): [string, string] {
    const timeStr = dt.toFormat('HHmmss')
    let dateStr: string
    if (legacy) {
        dateStr = dt.toFormat('yyMMdd')
    } else {
        dateStr = dt.toFormat('yyyyMMdd')
    }
    return [dateStr, timeStr]
}

export function encryptOn (sock: net.Socket, context: tls.TLSSocketOptions, hostname: string): tls.TLSSocket {
    if (!context) {
        context = {}
    }
    return tls.connect({
        socket: sock,
        ...context,
        servername: hostname
    })
}

