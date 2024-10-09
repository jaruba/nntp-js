// Response numbers that are followed by additional text (e.g. article)
export const LONGRESP: Set<string> = new Set([
  '100', // HELP
  '101', // CAPABILITIES
  '211', // LISTGROUP   (also not multi-line with GROUP)
  '215', // LIST
  '220', // ARTICLE
  '221', // HEAD, XHDR
  '222', // BODY
  '224', // OVER, XOVER
  '225', // HDR
  '230', // NEWNEWS
  '231', // NEWGROUPS
  '282' // XGTITLE
])

// Default decoded value for LIST OVERVIEW.FMT if not supported
export const DEFAULT_OVERVIEW_FMT = [
  'subject',
  'from',
  'date',
  'message-id',
  'references',
  ':bytes',
  ':lines'
]

// Alternative names allowed in LIST OVERVIEW.FMT response
export const OVERVIEW_FMT_ALTERNATIVES: { [key: string]: string } = {
  bytes: ':bytes',
  lines: ':lines'
}
