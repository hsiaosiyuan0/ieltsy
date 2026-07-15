export const ENGLISH_VARIANT = 'en-US' as const

const BRITISH_TO_AMERICAN: Readonly<Record<string, string>> = {
  ageing: 'aging',
  aluminium: 'aluminum',
  analyse: 'analyze',
  analysed: 'analyzed',
  analysing: 'analyzing',
  behaviour: 'behavior',
  behaviours: 'behaviors',
  cancelled: 'canceled',
  catalogue: 'catalog',
  catalogued: 'cataloged',
  catalogues: 'catalogs',
  cataloguing: 'cataloging',
  centre: 'center',
  centred: 'centered',
  centres: 'centers',
  colour: 'color',
  coloured: 'colored',
  colourful: 'colorful',
  colouring: 'coloring',
  colours: 'colors',
  cosy: 'cozy',
  defence: 'defense',
  defences: 'defenses',
  endeavour: 'endeavor',
  endeavoured: 'endeavored',
  endeavouring: 'endeavoring',
  endeavours: 'endeavors',
  enquiry: 'inquiry',
  enquiries: 'inquiries',
  favour: 'favor',
  favourable: 'favorable',
  favoured: 'favored',
  favouring: 'favoring',
  favourite: 'favorite',
  favourites: 'favorites',
  favours: 'favors',
  fibre: 'fiber',
  fibres: 'fibers',
  flavour: 'flavor',
  flavoured: 'flavored',
  flavours: 'flavors',
  fulfil: 'fulfill',
  fulfilled: 'fulfilled',
  fulfilling: 'fulfilling',
  fulfilment: 'fulfillment',
  fulfils: 'fulfills',
  grey: 'gray',
  harbour: 'harbor',
  harbours: 'harbors',
  honour: 'honor',
  honoured: 'honored',
  honouring: 'honoring',
  honours: 'honors',
  humour: 'humor',
  jewellery: 'jewelry',
  judgement: 'judgment',
  kilometre: 'kilometer',
  kilometres: 'kilometers',
  labelled: 'labeled',
  labelling: 'labeling',
  labour: 'labor',
  laboured: 'labored',
  labourer: 'laborer',
  labourers: 'laborers',
  labouring: 'laboring',
  labours: 'labors',
  licence: 'license',
  licences: 'licenses',
  litre: 'liter',
  litres: 'liters',
  maximisation: 'maximization',
  maximise: 'maximize',
  maximised: 'maximized',
  maximises: 'maximizes',
  maximising: 'maximizing',
  metre: 'meter',
  metres: 'meters',
  minimisation: 'minimization',
  minimise: 'minimize',
  minimised: 'minimized',
  minimises: 'minimizes',
  minimising: 'minimizing',
  modelling: 'modeling',
  neighbour: 'neighbor',
  neighbourhood: 'neighborhood',
  neighbourhoods: 'neighborhoods',
  neighbouring: 'neighboring',
  neighbours: 'neighbors',
  offence: 'offense',
  offences: 'offenses',
  practise: 'practice',
  practised: 'practiced',
  practises: 'practices',
  practising: 'practicing',
  programme: 'program',
  programmes: 'programs',
  rumour: 'rumor',
  rumours: 'rumors',
  savoury: 'savory',
  sceptical: 'skeptical',
  theatre: 'theater',
  theatres: 'theaters',
  towards: 'toward',
  travelled: 'traveled',
  traveller: 'traveler',
  travellers: 'travelers',
  travelling: 'traveling',
  tyre: 'tire',
  tyres: 'tires',
  utilisation: 'utilization',
  utilise: 'utilize',
  utilised: 'utilized',
  utilises: 'utilizes',
  utilising: 'utilizing',
  whilst: 'while',
}

const AMERICAN_TO_BRITISH = new Map<string, string[]>()
for (const [british, american] of Object.entries(BRITISH_TO_AMERICAN)) {
  const variants = AMERICAN_TO_BRITISH.get(american) ?? []
  variants.push(british)
  AMERICAN_TO_BRITISH.set(american, variants)
}

const BRITISH_SPELLING_PATTERN = new RegExp(
  `\\b(?:${Object.keys(BRITISH_TO_AMERICAN)
    .sort((left, right) => right.length - left.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
  'gi'
)

function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase()) return replacement.toUpperCase()
  if (source[0] === source[0]?.toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1)
  }
  return replacement
}

export function toAmericanHeadword(value: string): string {
  const normalized = value.trim().toLowerCase()
  return BRITISH_TO_AMERICAN[normalized] ?? normalized
}

export function toAmericanEnglish(value: string): string {
  return value.replace(BRITISH_SPELLING_PATTERN, (source) => {
    const replacement = BRITISH_TO_AMERICAN[source.toLowerCase()]
    return replacement ? matchCase(source, replacement) : source
  })
}

export function findBritishSpelling(value: string): string | undefined {
  return value.match(BRITISH_SPELLING_PATTERN)?.[0]
}

/** Exact US spelling first, then equivalent source spellings used by imported dictionaries. */
export function sourceHeadwordCandidates(value: string): string[] {
  const american = toAmericanHeadword(value)
  return [american, ...(AMERICAN_TO_BRITISH.get(american) ?? [])]
}

export function preferredContextRegion(date: string): 'United States' | 'Open/global' {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return weekday === 0 || weekday === 6 ? 'Open/global' : 'United States'
}
