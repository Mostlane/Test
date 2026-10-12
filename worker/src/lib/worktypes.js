/* ═══════════ Work types — the ONE taxonomy for "what kind of job is this?" ═══════════
   Used by: job area-of-work (job.workArea → engineer skills + scheduler weighting),
   subcontractor routing (which firm covers what), the drainage → Metro Rod flag, and
   the Co-op stats "trades" breakdown. Built from Southern Co-op's Concerto job emails
   (Oct 2026: their own "Asset : Fault" tags + the free-text fault descriptions) and
   the 23k-job Workever/Commusoft archive.

   Each type has:
     id, name, group      — group = the broad trade it rolls up to (for grouping in UIs)
     description          — what it covers, with examples, AND what it does NOT cover.
                            Shown to the office, and given to the AI as the definition.
     kw                   — [regex, weight] signals; a job's score per type is the sum of
                            the weights of every signal that matches. Strong, specific
                            phrases weigh 5–8; vague single words 1–2.
     not                  — regexes that veto the type outright (e.g. "drain-down" is EM).
     concerto             — Concerto asset names ("Drains", "Emergency lighting"...) that
                            map straight to this type (case-insensitive, exact asset).
   classifyWork(text) → { id, name, group, score, source, alts[] } or null.
   A Concerto tag at the front of the text ("Drains : Blocked (R, E) - …") wins outright. */

const W = (re, w) => [re, w];

export const WORK_GROUPS = [
  "Drainage", "Plumbing & water", "Heating, cooling & gas", "Electrical", "Fire safety",
  "Doors, windows & security", "Building fabric", "Roofs & external", "Fixtures & fittings",
  "Equipment & systems", "Hygiene & environment", "Compliance & testing", "Other",
];

export const WORK_TYPES = [
  /* ── Drainage ─────────────────────────────────────────────────────────── */
  { id: "drainage", name: "Drainage & blockages", group: "Drainage",
    description: "Anything BLOCKED or BACKING UP, and anything that SMELLS of drains. Blocked toilets, WCs, urinals, sinks, basins and wastes; toilets that won't flush away / water rising in the bowl; overflowing or backed-up drains; sewage or 'human waste' on the floor; foul / sewage / drain smells and odours; outside drains, gullies, manholes, inspection chambers, soakaways, interceptors, grease or fat traps; Saniflo / macerator / pumped waste units; drain jetting, CCTV drain surveys, rodding; rats coming up from drains. Usually a Metro Rod job. NOT: a pipe, tap or toilet that is LEAKING (Plumbing), a toilet that won't fill or flush because of the cistern mechanism (Plumbing), gutters and downpipes (Roofline & rainwater).",
    concerto: ["drains", "drain", "drainage", "blocked", "toilets blocked", "sewage"],
    kw: [
      W(/\bblock(?:ed|age|ages|ing up)\b|\bclogged\b|\bkeeps? blocking\b/i, 3),
      W(/\bdrains?\b.{0,60}\bblock(?:ed|ing)\b|\bblock(?:ed|ing)\b.{0,20}\bdrains?\b|\bseptic tank\b|\bcess ?pit\b|\bsinks? (?:and|&) (?:the )?toilets?\b.{0,30}\bblock|\b(?:sinks?|toilets?|pipes?|drains?|basins?)\b.{0,30}\b(?:clogged|blocking up)\b/i, 8),
      W(/\bdrain covers?\b|\braised edge\b/i, -6),
      W(/\bno (?:working )?toilets?\b|\btoilets? (?:are |is )?unavailable\b/i, 7),
      W(/\b(?:drains?|drainage|gull(?:y|ies)|sewers?|sewage|manholes?|inspection chambers?|soak ?aways?|interceptors?|grease traps?|fat traps?|aco\b|channel drain)/i, 5),
      W(/\b(?:toilets?|wcs?|loos?|urinals?|sinks?|basins?|pans?|waste)\s+(?:is |are |has |have |keeps? |still |now |completely |fully )*(?:blocked|backing up|backed up|overflowing|not draining|won'?t drain|not going down)/i, 8),
      W(/\bblocked\s+(?:toilets?|wcs?|loos?|urinals?|sinks?|basins?|drains?|pipes?|waste|pans?)\b/i, 8),
      W(/\b(?:backing|backed) up\b|\boverflowing\b|\bnot draining\b|\bwon'?t drain\b|\bslow(?:ly)? draining\b|water not going down/i, 5),
      W(/\b(?:smell|smells|smelly|odou?rs?|stinks?|stench|whiff)\b/i, 4),
      W(/\b(?:sewage|drain|drains|foul|sewer|egg|rotten)\s*(?:smell|odou?r)|smells? (?:like|of) (?:sewage|drains?|sewer|poo|rotten)/i, 8),
      W(/\bhuman waste\b|\bfaec|\bpoo\b|\bexcrement\b(?!.*\brat)/i, 5),
      W(/\bsani ?fl[oa]w?s?\b|\bmacerator\b|\bpumped waste\b|\bwaste pump\b/i, 8),
      W(/\bjetting\b|\bjet the drain|\brodding\b|\bcctv\b.{0,25}\bdrains?\b|drain survey/i, 8),
      W(/\bfoul water\b|\bsurface water\b.*\bdrain|\bstanding water\b/i, 4),
      W(/\bmetro ?rod\b|\blanes\b group/i, 6),
    ],
    not: [/drain[\s-]*down/i, /\bem\b.*\bdrain/i] },

  /* ── Plumbing & water ─────────────────────────────────────────────────── */
  { id: "plumbing", name: "Plumbing — leaks, taps & toilets", group: "Plumbing & water",
    description: "Water pipework and sanitaryware that LEAKS or doesn't work, where the problem is the supply side, not a blockage. Leaking pipes, joints, valves and fittings; dripping or broken taps, taps that won't turn off, low flow; toilets / cisterns that leak, run constantly, won't fill or won't flush (flush button, ballcock, fill valve, syphon); urinal flush controls; no water / no cold water; low water pressure; stopcocks and isolation valves; burst or frozen pipes; water leaking from under a sink, coffee machine or appliance connection. NOT: blocked toilets / sinks or smells (Drainage), no HOT water or water heaters (Hot water & water heaters), toilet seats, hand dryers or dispensers (Washroom fittings), water coming through a ceiling from an unknown source (Leaks & water ingress).",
    concerto: ["pipe work", "pipework", "toilets", "toilet", "taps", "tap", "water supply", "cistern", "urinal", "urinals", "sink", "sinks", "plumbing", "toilets leaking"],
    kw: [
      W(/\bleak(?:s|ing|ed|y)?\b|\bdrip(?:s|ping|py)?\b/i, 5),
      W(/\btaps?\b/i, 4),
      W(/\b(?:pipe|pipes|pipework|pipe work|joint|valve|fitting|connection)s?\b.*\bleak|\bleak.*\b(?:pipe|pipes|pipework|joint|valve)/i, 6),
      W(/\bcisterns?\b|\bballcock\b|\bfill(?:ing)? valve\b|\bsyphon\b|\bsiphon\b|\bflush(?:ing)? (?:button|handle|mechanism)\b|\bflush plate\b/i, 7),
      W(/\b(?:toilet|wc|loo|urinal)s?\b.*\b(?:not flushing|won'?t flush|constantly (?:flushing|running)|running constantly|keeps (?:flushing|running)|leak|not filling|won'?t fill)/i, 8),
      W(/\b(?:not|won'?t|isn'?t|doesn'?t) (?:flushing|flush)\b|\bflush\b|\bfloat\b|\brefill(?:ing)?\b|\btoilet (?:bowl|pan|handle)\b|\bpan (?:is )?cracked\b/i, 5),
      W(/\btaps?\b.{0,30}\b(?:will not|won'?t|wont|doesn'?t|not) turn off\b|\bconstantly running\b/i, 8),
      W(/\bno (?:running |cold )?water\b|\bpipes? (?:are |have |has )?frozen\b|\bwater (?:has been |is )?(?:off|cut off)|\blow (?:water )?pressure\b|\bpoor flow\b|\bwon'?t flow\b/i, 6),
      W(/\bstop ?cocks?\b|\bisolat(?:ion|ing) valve\b|\bburst (?:pipe|main)\b|\bfrozen pipes?\b|\bwater main\b/i, 7),
      W(/\btoilets?\b|\bwcs?\b|\burinals?\b|\bsinks?\b|\bbasins?\b/i, 1),
      W(/\bplumb(?:er|ing)\b/i, 4),
    ],
    not: [] },

  { id: "hot-water", name: "Hot water & water heaters", group: "Plumbing & water",
    description: "No hot water, or the unit that makes it. Under-sink and over-sink water heaters (Heatrae, Zip, Redring, Ariston, Hyco), instantaneous heaters, boiling-water taps and urns (Zip HydroTap, Instanta, Marco), immersion heaters, unvented hot-water cylinders and calorifiers, water heaters that dribble, scald, trip or make noise. NOT: space heating / radiators (Heating), a cold tap that leaks (Plumbing), kettles (Catering & appliances).",
    concerto: ["water heater", "water heaters", "hot water", "boiling water"],
    kw: [
      W(/\bwater heaters?\b|\bheatrae\b|\bzip\b(?! ?tie)|\bredring\b|\bred ring\b|\bhyco\b|\bariston\b|\bmegaflo\b|\bunvented\b|\bcalorifiers?\b|\bimmersion\b/i, 8),
      W(/\b(?:no|not providing|not producing|not giving|without) (?:any )?hot water\b|\bno hot water\b|\bhot water\b.*\b(?:not|isn'?t|won'?t)\b|\bwater (?:is |isn'?t |not )*(?:getting |going )?(?:hot|warm)\b|\bluke ?warm\b/i, 7),
      W(/\bhot water\b/i, 4),
      W(/\bboiling water\b|\bhydro ?tap\b|\binstanta\b|\burn\b|\bhot tap\b/i, 6),
    ],
    not: [] },

  { id: "water-hygiene", name: "Water hygiene & legionella", group: "Plumbing & water",
    description: "Keeping the water system safe rather than fixing a fault. Legionella risk assessments and remedials, dead legs and redundant pipework ('causing a deadleg'), TMVs (thermostatic mixing valves) servicing, cold-water storage tanks, water sampling, descaling and disinfection, flushing regimes, redundant calorifiers and tanks being drained down and removed. NOT: a tap or pipe that simply leaks (Plumbing).",
    concerto: ["legionella", "water hygiene", "tmv"],
    kw: [
      W(/\blegionell?a\b|\bdead ?legs?\b|\bdead ?end\b|\bdeadlog\b|\btmvs?\b|\bthermostatic mixing\b|\bwater (?:sampl|hygiene|tank)|\bcold water (?:storage )?tank\b|\bdisinfect|\bdescal/i, 8),
      W(/\bredundant (?:pipe|pipework|calorifier|tank|system)|\bcap(?:ped)? off\b/i, 5),
    ],
    not: [] },

  /* ── Heating, cooling & gas ──────────────────────────────────────────── */
  { id: "heating", name: "Heating — heaters, radiators & boilers", group: "Heating, cooling & gas",
    description: "Keeping the building warm. Heating not coming on, shop floor / office / colleague room too cold; radiators (cold, leaking valves, brackets pulled off the wall, TRVs); wall and panel heaters, fan heaters, storage heaters, over-door / air-curtain heaters, thermostats and timers, heat pumps used for heating, boilers (non-gas-safety faults), pressure loss. NOT: no hot water at the tap (Hot water), gas safety certificates or smell of gas (Gas), air-con not cooling (Air conditioning), fridge/freezer temperatures (Refrigeration).",
    concerto: ["heating", "heater", "heaters", "radiator", "radiators", "boiler", "thermostat", "air curtain", "door heater"],
    kw: [
      W(/\bheating\b|\bheaters?\b|\bradiators?\b|\btrvs?\b|\bthermostats?\b|\bair ?curtains?\b|\bover ?door heater|\bstorage heaters?\b|\bheat pumps?\b/i, 7),
      W(/\bboilers?\b/i, 5),
      W(/\b(?:too|very|freezing|really|particularly|so|quite|extremely|bitterly) cold\b|\bcold (?:in|on) the\b|\bfreezing in\b/i, 5),
      W(/\bdegrees\b/i, 2),
      W(/\bnot (?:heating|warming|warm)\b|\bno heat\b/i, 6),
    ],
    not: [] },

  { id: "gas", name: "Gas — appliances, safety & smell of gas", group: "Heating, cooling & gas",
    description: "Anything that needs a Gas Safe engineer. Smell of gas / suspected gas leak, gas boilers, gas cookers and hobs, gas fires, landlord gas safety certificates (CP12) and annual gas safety inspections, gas meters and supply pipework. NOT: electric heaters or radiators with no gas fault (Heating), electric cookers (Catering & appliances).",
    concerto: ["gas", "gas supply", "gas appliance"],
    kw: [
      W(/\bgas\b(?! ?(?:lift|strut|spring))/i, 6),
      W(/\bcarbon monoxide\b|\bco alarm\b|\bsmell of gas\b|\bgas (?:leak|smell)\b|\bsmells? (?:like |of )?gas\b|\bgas safe\b|\bgas safety\b|\bcp12\b|\bgas (?:boiler|cooker|hob|fire|meter|supply)/i, 10),
    ],
    not: [] },

  { id: "air-con", name: "Air conditioning", group: "Heating, cooling & gas",
    description: "Comfort cooling. Air-con units not cooling, leaking condensate, noisy, error codes, remote controls; split / cassette / VRF units, outdoor condensers for the AC; the store being too hot. NOT: fridges, freezers, chillers or cold rooms (Refrigeration), extract fans (Ventilation), heating (Heating).",
    concerto: ["air conditioning", "air con", "aircon", "hvac", "comfort cooling"],
    kw: [
      W(/\bair ?con(?:dition(?:ing|er))?\b|\bairco(?:n|ndition)|\ba\/c\b|\bhvac\b|\bcassette units?\b|\bsplit units?\b|\bvrf\b|\bcomfort cooling\b/i, 10),
      W(/\b(?:too |very |really )hot\b|\boverheating\b(?!.*(?:socket|plug|cable))/i, 3),
    ],
    not: [] },

  { id: "refrigeration", name: "Refrigeration — fridges, freezers & chillers", group: "Heating, cooling & gas",
    description: "Cold-chain kit. Fridges, freezers, multideck chillers, back-up chillers, cold rooms and walk-ins, wine chillers, ice machines, display cabinets out of temperature, temperature alarms, compressors and condensers for the refrigeration, iced-up evaporators, door seals on fridges. Co-op usually sends these to their refrigeration contractor. NOT: air-con (Air conditioning), the FLOOR inside a freezer room (Flooring), pest-proofing behind a chiller (Pest control).",
    concerto: ["refrigeration", "chiller", "chillers", "freezer", "freezers", "fridge", "fridges", "cold room", "temperature issues", "multideck", "ice machine"],
    kw: [
      W(/\bfridges?\b|\bfreezers?\b|\bchillers?\b|\bmulti ?decks?\b|\bcold ?rooms?\b|\bwalk[- ]in\b|\bice (?:machine|maker)s?\b|\brefrigerat/i, 7),
      W(/\bcompressors?\b|\bcondensers?\b|\bevaporator\b|\bout of temp|\btemperature (?:alarm|issue|problem)|\bnot (?:cooling|cold|chilling|freezing)\b|\bdefrost/i, 5),
    ],
    not: [/\bproof(?:ing)?\b/i] },

  { id: "ventilation", name: "Ventilation & extraction", group: "Heating, cooling & gas",
    description: "Moving air out. Extractor fans in toilets and kitchens, bakery and catering extract canopies, ducting, air handling units, louvres, ventilation grilles, noisy or seized fans, filters. NOT: air-con cooling (Air conditioning), heating (Heating).",
    concerto: ["ventilation", "extraction", "extract fan", "extractor fan"],
    kw: [
      W(/\bextract(?:or)?(?: fans?| canopy| hood| system)?\b|\bventilat|\bducting\b|\bair handling\b|\bahus?\b|\blouvres?\b|\bvent(?:s)?\b(?!ure)/i, 7),
      W(/\bfans?\b/i, 2),
    ],
    not: [] },

  /* ── Electrical ──────────────────────────────────────────────────────── */
  { id: "electrical-power", name: "Electrical — power, sockets & tripping", group: "Electrical",
    description: "Power problems. No power / partial power, power cuts, circuits or RCDs tripping, trip switches that won't reset, fuses, consumer units and distribution boards, sockets and spurs not working or damaged, burning smell or scorching at a socket, exposed or damaged cables and wiring, isolators, three-phase supply issues, electrical sub-mains, new circuits and sockets. Also fly zappers / insect killers (fitting, replacing, not working — an electrician job, not pest control), 'needs an electrician', wiring to be checked, overrides not working. NOT: lights (Lighting), emergency lights (Emergency lighting), tills / card readers / phones (IT, tills & telecoms), testing and certificates (Electrical testing).",
    concerto: ["electrics", "electrical", "electricity", "power", "system", "cables/wiring", "cables", "wiring", "sockets", "socket", "distribution board", "fuse board", "consumer unit"],
    kw: [
      W(/\bno power\b|\bpower (?:cut|outage|loss|failure|off)|\blost power\b|\bnothing is working\b|\btripp(?:ed|ing)\b|\btrips\b|\btrip switch\b|\brcds?\b|\brcbos?\b|\bmcbs?\b/i, 8),
      W(/\bsockets?\b|\bspurs?\b|\bplug socket\b|\bfused spur\b/i, 7),
      W(/\bfuse(?:s|d| board| box)?\b|\bconsumer units?\b|\bdistribution boards?\b|\bdb\b|\bisolators?\b|\bthree[- ]phase\b|\bsub[- ]?mains?\b/i, 6),
      W(/\bexposed (?:copper )?wires?\b|\byellow ?\/ ?green\b|\bexternal (?:plug|socket)\b|\bip ?rated\b|\bplugs?\b(?!\s*holes?)|\b(?:cables?|wires?|wiring)\b.*\b(?:exposed|damaged|hanging|out|loose|live|bare)|\b(?:exposed|damaged|loose|live|bare) (?:cables?|wires?|wiring)\b|\bburning smell\b|\bscorch/i, 8),
      W(/\belectric(?:al|s|ity|ian)?\b|\bpower\b/i, 3),
      W(/\bfly (?:zappers?|killers?|units?|control units?)\b|\binsect(?:ocutor|o-?cutor|killer)s?\b|\binsecutor\b|\blumn?ia\b|\bfly (?:sticker|glue) (?:paper|board)s?\b/i, 10),
      W(/\bneeds? an electrician\b|\belectrician (?:to|needed|required)\b|\b(?:check|checking|test|testing) (?:the )?wiring\b|\bwiring (?:check(?:ing|ed)?|needs? checking)\b|\bneeds? (?:the )?wiring check/i, 10),
      W(/\boverrides?\b/i, 5),
    ],
    not: [] },

  { id: "lighting", name: "Lighting (general)", group: "Electrical",
    description: "Normal lights that are off, flickering or damaged — inside and out. Shop-floor LED panels and battens, strip lights / fluorescent tubes, warehouse and office lights, sensor / PIR lights, external and car-park lights, signage and fascia lighting, forecourt canopy lighting, lamps and drivers, light switches. NOT: emergency lights / EM fittings that fail their test (Emergency lighting), the sign itself being loose or damaged (Signage).",
    concerto: ["lighting", "lights", "light", "external lighting", "internal lighting", "forecourt/canopy lighting", "led lighting"],
    kw: [
      W(/\blights?\b|\blighting\b|\blamps?\b|\bbulbs?\b|\btubes?\b|\bled panels?\b|\bbattens?\b|\bfluorescent\b|\bstrip ?lights?\b|\bdownlights?\b|\bflood ?lights?\b|\bpir\b|\bsensor lights?\b/i, 6),
      W(/\bflicker(?:s|ing)?\b|\bbulb (?:gone|out)\b|\bin the dark\b|\bvery dark\b/i, 4),
      W(/\b(?:lights?|lighting|lamp ?posts?|street ?lights?)\b.{0,40}\b(?:not (?:working|coming on|turning on|on)|haven'?t (?:turned|come) on|(?:are|is|went|gone|turned) (?:off|out)|won'?t (?:come|turn) on|no longer|keep(?:s)? going off|randomly)|\blamp ?posts?\b|\blight (?:fixture|fitting)s?\b|\blighting timer\b|\btimer\b.{0,30}\blight/i, 6),
      W(/\blight switch(?:es)?\b|\bsign(?:age)? light(?:s|ing)?\b|\billuminated sign/i, 8),
    ],
    not: [/\bgreen light\b|\bdid not stay (?:il)?luminated\b|\ba\d?em\b|\bem\/\d+/i, /\bem ?(?:light|lighting|fitting|test)\b|\bem ?\d{1,3}\b/i, /\bwarning light\b/i, /\bemergency (?:light|lighting) (?:test|failed|fail)/i] },

  { id: "emergency-lighting", name: "Emergency lighting", group: "Electrical",
    description: "Emergency lighting only. EM fittings / bulkheads / exit signs that fail the monthly flick test or the 3-hour duration test, stay on or won't charge, EM lights numbered on the site plan (EM12, EM24…), replacement EM fittings and batteries, EM certificates. NOT: ordinary lights (Lighting), fire alarms (Fire alarms & detection).",
    concerto: ["emergency lighting", "emergency lights", "emergency light", "em lighting"],
    kw: [
      W(/\bemergency (?:light|lighting|lights|fitting|bulkhead|exit)/i, 13),
      W(/\b(?:except|apart from|but) (?:for )?(?:the )?emergency light|\bemergency light(?:s|ing)? (?:still )?(?:work|on|came on|come on)|\b(?:switched|gone|went) (?:on )?(?:to|onto) emergency|\bon emergency\b/i, -14),
      W(/\bem ?\d{1,3}\b|\bem (?:light|lighting|fitting|test|cert)|\b3 ?h(?:ou)?r (?:em )?test\b|\bflick tests?\b|\bexit signs?\b|\brunning man\b|\(eml\)|\bem:/i, 9),
      W(/\bgreen light\b.{0,30}\btest|\btest(?:ed)?\b.{0,40}\bgreen light|\bdid not stay (?:il)?luminated\b|\bemergency test\b|\ba\d?em\b|\bem\/\d+|\b(?:3|three)[- ]?h(?:ou)?r (?:em )?drain[- ]?down\b|\bdrain[- ]?down test\b|\bem drain[- ]?down\b/i, 12),
    ],
    not: [] },

  { id: "electrical-testing", name: "Electrical testing & certificates", group: "Compliance & testing",
    description: "Planned electrical testing, not a fault. EICRs / 5-year fixed-wire tests, PAT testing, importing or issuing electrical certificates, remedial works listed on an EICR (C1/C2/FI codes), periodic inspections. NOT: a fault reported by the store (the matching Electrical / Lighting type), emergency-light tests (Emergency lighting).",
    concerto: ["eicr", "fixed wire", "pat testing", "electrical testing"],
    kw: [
      W(/\(pat\)|\beicr\b|\b5[- ]?y(?:ea)?r (?:electrical )?test|\bfive[- ]year\b|\bfixed[- ]wire\b|\bperiodic inspection\b|\bpat test|\bpat\b|\bimport certificate\b|\bc1\b|\bc2\b/i, 10),
    ],
    not: [/\(eml\)/i, /\bem:/i, /\bdrain[- ]?down\b/i] },

  /* ── Fire safety ─────────────────────────────────────────────────────── */
  { id: "fire-alarms", name: "Fire alarms & detection", group: "Fire safety",
    description: "Fire detection and fire-fighting kit. Fire alarm panels showing a fault, false alarms, call points, smoke and heat detectors (and beeping smoke alarms in flats), sounders and beacons, sprinklers, fire extinguishers and fire blankets, fire alarm servicing. NOT: fire doors (Fire doors & fire exits), emergency lights (Emergency lighting), fire stopping (Firestopping).",
    concerto: ["fire alarm", "fire alarms", "fire panel", "smoke detector", "smoke alarms", "fire extinguisher", "fire extinguishers", "sprinklers", "fire detection"],
    kw: [
      W(/\bfire ?alarms?\b|\bfire panel\b|\bsmoke (?:alarm|detector|head)s?\b|\bheat detectors?\b|\bcall points?\b|\bsounders?\b|\bsprinklers?\b|\bextinguishers?\b|\bfire blankets?\b|\bfalse alarms?\b/i, 9),
    ],
    not: [] },

  { id: "fire-doors", name: "Fire doors & fire exits", group: "Fire safety",
    description: "Doors whose job is fire safety. Fire doors that won't close or latch, damaged frames, missing or failed intumescent strips and smoke seals, gaps around fire doors, door closers on fire doors, hold-open / magnetic release devices, fire exit doors, panic bars / push bars, fire door inspections and signage on fire doors. NOT: ordinary internal or front doors (Doors), locks and keys (Locks, keys & access), fire stopping in walls (Firestopping).",
    concerto: ["fire door", "fire doors", "fire exit", "fire exits", "panic bar"],
    kw: [
      W(/\bfire (?:exit |escape )?doors?\b|\bfire exits?\b|\bfire escape\b|\bpanic (?:bar|bolt|hardware)s?\b|\bpush bars?\b|\bhold[- ]open\b|\bmag(?:netic)? (?:release|hold)|\belectro ?magnetic hold|\bintumescent strips?\b|\bsmoke seals?\b/i, 12),
    ],
    not: [] },

  { id: "firestopping", name: "Firestopping & compartmentation", group: "Fire safety",
    description: "Fire stopping in walls, floors and ceilings: penetration seals around pipes and cables, fire collars, fire batts, intumescent mastic and pillows, compartmentation surveys and remedial works from a fire risk assessment (FRA works). NOT: fire doors (Fire doors & fire exits), pest-proofing gaps (Pest control).",
    concerto: ["fire stopping", "firestopping", "compartmentation"],
    kw: [
      W(/\bfire ?stop(?:ping)?\b|\bpenetration seals?\b|\bfire (?:collar|batt|pillow|barrier)s?\b|\bcompartmentation\b|\bfra works?\b|\bfire risk (?:assessment )?works\b|\bintumescent (?:mastic|sealant)\b/i, 10),
    ],
    not: [] },

  /* ── Doors, windows & security ───────────────────────────────────────── */
  { id: "doors", name: "Doors, frames & closers", group: "Doors, windows & security",
    description: "Ordinary doors that stick, drop, won't close, are damaged or coming off: warehouse doors, colleague-room and toilet doors, front and back doors, door frames, hinges, door closers, kick plates, door bumpers and buffers, handles that are loose, swing doors, saloon doors. NOT: fire doors / fire exits / panic bars (Fire doors & fire exits), locks, keys, bolts and access control (Locks, keys & access), automatic sliding entrance doors (Automatic doors), roller shutters (Shutters, gates & grilles).",
    concerto: ["door", "doors", "internal door", "external door", "warehouse door", "door closer", "doors/frames"],
    kw: [
      W(/\bdoors?\b/i, 4),
      W(/\bdoor ?(?:frames?|closers?|hinges?|handles?|stops?|bumpers?|buffers?|kick ?plates?)\b|\bhinges?\b|\bswing doors?\b|\bsaloon doors?\b/i, 7),
      W(/\b(?:won'?t|doesn'?t|does not|not) (?:shut|close) (?:properly|fully)?\b|\bcatch(?:ing)? on the floor\b|\bdrop(?:ped)?\b|\bframe\b|\bhandle\b|\bsticking\b|\bbristle strips?\b/i, 4),
      W(/\b(?:cabinet|cupboard|kiosk|wardrobe|fridge|freezer|chiller|unit|counter|oven|machine) doors?\b|\bdoors? (?:of|on) the (?:[\w-]+ )?(?:cabinet|cupboard|kiosk|fridge|freezer|chiller|unit|counter|oven|machine)s?\b/i, -8),
    ],
    not: [] },

  { id: "locks-access", name: "Locks, keys & access", group: "Doors, windows & security",
    description: "Getting in and keeping secure. Locks that are broken, stiff or jammed, cylinders and barrels, mortice locks, padlocks, bolts (top and bottom), keys snapped in locks, lost keys and key cutting, key safes and key boxes, digital / code locks, door entry and intercom systems, access control fobs, cabinets (vape / tobacco / cash) that won't lock. NOT: the door itself not closing (Doors), CCTV and intruder alarms (Security systems).",
    concerto: ["locks", "lock", "locks/keys", "keys", "access control", "door entry", "intercom"],
    kw: [
      W(/\blocks?\b(?!er)|\blocked out\b|\bunlock|\bcylinders?\b|\bbarrels?\b|\bmortice\b|\bpadlocks?\b|\bbolts?\b|\blatch(?:es)?\b|\bkeys?\b(?!board|pad)/i, 6),
      W(/\bdigi ?lock\b|\bpasscode\b|\btill safe\b|\bkey ?(?:safe|box)\b|\bcode lock\b|\bdigi(?:tal)? lock\b|\bdoor entry\b|\bintercom\b|\baccess control\b|\bfobs?\b|\bmag ?lock\b|\bmaglock\b/i, 9),
      W(/\b(?:not|isn'?t) secure\b|\bcan(?:not|'?t) be locked\b|\bwon'?t lock\b/i, 7),
    ],
    not: [/\bblocked\b/i] },

  { id: "automatic-doors", name: "Automatic doors", group: "Doors, windows & security",
    description: "Powered entrance doors. Automatic sliding or swing doors that won't open, won't close, open on their own, stick or bang; door sensors and motion detectors, door operators and controllers, program switches, bi-parting entrance doors, revolving doors. NOT: manual doors (Doors), roller shutters (Shutters, gates & grilles).",
    concerto: ["automatic door", "automatic doors", "auto doors", "entrance doors", "sliding doors"],
    kw: [
      W(/\bauto(?:matic)? (?:sliding )?(?:entrance )?doors?\b|\bsliding doors?\b|\bauto doors?\b|\bentrance doors?\b|\bdoor sensors?\b|\bdoor operators?\b|\brevolving doors?\b|\bbi[- ]?parting\b|\bdormakaba\b|\bdorma\b|\bgeze\b|\bassa abloy\b|\brecord doors?\b/i, 10),
    ],
    not: [] },

  { id: "shutters-gates", name: "Shutters, gates & grilles", group: "Doors, windows & security",
    description: "Roller shutters (manual and electric) that are stuck, noisy, off their guides or won't lock; security grilles; loading-bay and up-and-over doors; sliding and swing gates; car-park and yard gates and barriers; gate motors and keypads. NOT: automatic glass entrance doors (Automatic doors), fencing (Fencing & barriers).",
    concerto: ["shutter", "shutters", "roller shutter", "roller shutters", "gates", "gate", "grilles", "loading bay"],
    kw: [
      W(/\b(?:roller )?shutters?\b|\bgrilles?\b|\bloading bay\b|\bup[- ]and[- ]over\b|\bdock levell?er\b|\bgates?\b|\bbarrier arm\b|\bentry barrier\b/i, 9),
    ],
    not: [] },

  { id: "glazing", name: "Glazing & windows", group: "Doors, windows & security",
    description: "Glass and windows. Cracked, shattered or broken glass and double-glazed units, shopfront glazing, glass doors, misted units, windows that won't open or close, window handles, hinges and restrictors, window sills, leaking windows, perspex and safety film, mirrors that are glass panels. NOT: boarding up after a break-in (Boarding up & make safe — unless the glass itself is being replaced), automatic entrance doors (Automatic doors).",
    concerto: ["glazing", "glass", "windows", "window", "shopfront", "double glazing"],
    kw: [
      W(/\bglaz(?:ing|ed|ier)\b|\bglass\b|\bdouble glazed\b|\bsealed units?\b|\bmisted\b|\bshop ?front\b|\btoughened\b|\bperspex\b|\bsafety film\b|\bshattered\b|\bcracked (?:pane|window|glass)\b/i, 9),
      W(/\bwindows?\b|\bpanes?\b|\bwindow (?:handle|hinge|restrictor|sill|frame)s?\b/i, 6),
      W(/\bsmash(?:ed|ing)?\b|\bcrack(?:ed)?\b.{0,30}\b(?:panel|pane|glass)\b|\breglaz|\breplace(?:ment)?\b.{0,40}\b(?:window|glass|glazing|pane)|\b(?:window|glass|glazing|pane)\b.{0,80}\breplace/i, 6),
    ],
    not: [] },

  { id: "make-safe", name: "Boarding up & make safe", group: "Doors, windows & security",
    description: "Emergency response after damage or a break-in: boarding up windows and doors, securing a site, making safe after a vehicle impact, storm damage, vandalism or an attempted break-in, temporary fencing or barriers to keep people away, removing a dangerous item. NOT: the permanent repair that follows (the matching type — Glazing, Doors, etc.).",
    concerto: ["make safe", "boarding", "board up", "break in", "vandalism", "storm damage"],
    kw: [
      W(/\bboard(?:ed|ing)? ?up\b|\bboarded\b|\bmake (?:it )?safe\b|\bmaking safe\b|\bbreak[- ]?in\b|\bburglar|\bbroken into\b|\bram ?raid\b|\bvandal|\bvehicle (?:impact|hit|crashed)\b|\bstorm damage\b|\bsecure the (?:site|building|store)\b/i, 7),
    ],
    not: [] },

  { id: "security-systems", name: "CCTV & intruder alarms", group: "Doors, windows & security",
    description: "Electronic security: CCTV cameras and recorders, monitors, intruder / burglar alarm panels and PIRs, panic and attack alarms, alarm keypads and codes, security tagging gates (EAS), body-worn cameras. NOT: locks and access control (Locks, keys & access), fire alarms (Fire alarms & detection).",
    concerto: ["cctv", "intruder alarm", "security alarm", "panic alarm", "alarm"],
    kw: [
      W(/\bcameras?\b/i, 3),
      W(/\bcctv\b(?! (?:survey|camera down the drain))|\bsmoke cloak\b|\bfog(?:ging)? (?:system|cannon)\b|\bintruder alarm\b|\bburglar alarm\b|\bsecurity alarm\b|\bpanic (?:alarm|button)s?\b|\battack alarm\b|\balarm (?:panel|keypad|code)\b|\beas\b|\btagging gates?\b|\bbody ?cams?\b/i, 9),
    ],
    not: [/\bdrains?\b/i, /\bfire\b/i, /\bflexi(?:ble)? camera\b|\bcamera survey\b/i] },

  /* ── Building fabric ─────────────────────────────────────────────────── */
  { id: "leaks-ingress", name: "Leaks & water ingress (source unknown)", group: "Building fabric",
    description: "Water appearing where it shouldn't when the source isn't known yet: water coming through the ceiling, dripping from above, leaking from the flat or unit above, water running down a wall, puddles appearing after rain, wet ceiling tiles. Someone needs to trace it — it may turn out to be the roof, gutters, a window or plumbing. NOT: a leak from an obvious pipe, tap or toilet (Plumbing), a known roof defect (Roofing).",
    concerto: ["ceiling", "ceiling leak", "water ingress", "leak", "leaks", "flooding"],
    kw: [
      W(/\b(?:leak|leaks|leaking|water|dripping|drips)\b.{0,40}\b(?:ceiling|from above|from the flat|flats? above|block above|above|through the (?:roof|ceiling|wall|floor)|down the wall|up through the floor)\b|\bceiling\b.{0,30}\bleak/i, 11),
      W(/\bpuddles?\b|\bwater pouring\b|\bpouring (?:in|through|down)\b|\bceiling\b.{0,30}\b(?:collapsed|fallen through|caved)\b|\bleaks? (?:have |has )?(?:appear|appeared|appearing)\b|\bleaks? in (?:the |our )?(?:warehouse|store|shop|office|stockroom)\b/i, 8),
      W(/\bwater ingress\b|\bwater coming (?:in|through)\b|\bwhen(?:ever)? it rains\b|\bafter (?:heavy )?rain\b|\brain ?water\b(?! goods)/i, 8),
      W(/\bflood(?:ed|ing)?\b/i, 4),
    ],
    not: [] },

  { id: "roofing", name: "Roofing", group: "Roofs & external",
    description: "The roof itself: flat-roof felt and membranes, pitched-roof tiles and slates, roof leaks with a known roof cause, skylights and roof lights, lead flashing, chimneys, roof access hatches and ladders, moss and vegetation on the roof, storm-damaged roofs. NOT: gutters, downpipes, fascias and soffits (Roofline & rainwater), water through a ceiling where the cause is unknown (Leaks & water ingress).",
    concerto: ["roof", "roofs", "roofing", "flat roof", "roof leak", "skylight", "roof light"],
    kw: [
      W(/\broof(?:s|ing)?\b|\bflat roof\b|\bfelt\b|\bslates?\b|\bridge tiles?\b|\bskylights?\b|\broof ?lights?\b|\blead flashing\b|\bflashing\b|\bchimney\b|\broof hatch\b/i, 9),
    ],
    not: [] },

  { id: "rainwater", name: "Roofline & rainwater (gutters, downpipes, fascias)", group: "Roofs & external",
    description: "Everything that carries rain off the building and finishes the roof edge: gutters (blocked, leaking, broken, overflowing), downpipes and hoppers, rainwater goods, fascia boards, soffits, bargeboards, gutter clearing. NOT: the roof covering (Roofing), below-ground drains (Drainage).",
    concerto: ["gutters", "guttering", "gutter", "downpipe", "downpipes", "fascia", "soffit", "rainwater goods"],
    kw: [
      W(/\bgutter(?:s|ing)?\b|\bdown ?pipes?\b|\bhoppers?\b|\brain ?water goods\b|\bfascias?\b(?! sign)|\bsoffits?\b|\bbarge ?boards?\b|\bdownpipe collector\b/i, 11),
    ],
    not: [] },

  { id: "ceilings", name: "Ceilings & ceiling tiles", group: "Building fabric",
    description: "The ceiling itself: missing, stained, sagging or fallen suspended-ceiling tiles, ceiling grid, plasterboard ceilings that are cracked or coming down, access panels, replacing tiles after a leak has been fixed. NOT: the leak that caused it (Leaks & water ingress / Plumbing / Roofing), lights in the ceiling (Lighting).",
    concerto: ["ceilings", "ceiling tiles", "suspended ceiling"],
    kw: [
      W(/\bceiling ?tiles?\b|\bsuspended ceiling\b|\bceiling grid\b|\bceiling (?:has |is )?(?:come|coming|fallen|falling) down\b/i, 7),
      W(/\bceiling\b/i, 2),
      W(/\bleak(?:s|ing)?\b(?!.{0,20}\b(?:has been|was|now) (?:fixed|repaired|resolved))/i, -4),
      W(/\btiles?\b.*\b(?:stained|missing|fallen|came down|come down)\b/i, 3),
    ],
    not: [] },

  { id: "flooring", name: "Flooring", group: "Building fabric",
    description: "Floors inside the building: lifting, cracked or missing floor tiles, vinyl and safety flooring (Altro), carpet, matting and entrance mats, screed, raised or uneven floors that are a trip hazard indoors, freezer-room floors, floor nosings and stair treads. NOT: external paving and car parks (Car parks & external surfaces), wall tiles (Walls, plaster & tiling).",
    concerto: ["flooring", "floor", "floors", "floor tiles", "carpet", "matting"],
    kw: [
      W(/\bfloor ?(?:tiles?|ing|covering)\b|\bvinyl\b|\baltro\b|\bcarpets?\b|\bentrance mat|\bmatting\b|\bscreed\b|\bnosings?\b|\bstair treads?\b/i, 8),
      W(/\btiles?\b.{0,40}\b(?:lift(?:ing|ed)|raised|raising|coming up|come up|came up|loose|cracked|worn|damaged)\b|\bholes? in the (?:warehouse |shop )?floor\b|\brubber (?:type )?tiles?\b|\bstripping (?:has )?(?:come|coming) up\b|\b(?:lift(?:ing|ed)|raised|coming up)\b.{0,30}\btiles?\b|\buneven\b/i, 6),
      W(/\bfloor\b/i, 3),
      W(/\btrip hazard\b/i, 4),
    ],
    not: [] },

  { id: "walls-plaster", name: "Walls, plaster & tiling", group: "Building fabric",
    description: "Inside walls and partitions: holes, cracks and damage to plasterboard and plaster, wall tiles and grout, hygienic wall cladding (PVC / Whiterock), wall protection and corner guards, crash rails and bump strips on walls, partitions and stud walls, silicone and sealant around worktops, sinks and walls. NOT: damp and mould (Damp & mould), outside masonry and render (Brickwork & external walls), painting (Decorating).",
    concerto: ["walls", "wall", "internal walls", "wall tiles", "cladding", "wall protection"],
    kw: [
      W(/\bwalls?\b|\bplaster(?:board|ing)?\b|\bstud wall\b|\bpartitions?\b|\bwall tiles?\b|\bgrout\b|\bwhiterock\b|\bhygienic (?:wall|cladding)\b|\bcladding\b|\bcorner guards?\b|\bcrash rails?\b|\bwall protection\b/i, 6),
      W(/\bsealant\b|\bsilicone\b|\bmastic\b/i, 4),
      W(/\bholes? in the wall\b|\bcrack(?:s|ed)? in the wall\b/i, 6),
    ],
    not: [] },

  { id: "damp-mould", name: "Damp & mould", group: "Building fabric",
    description: "Damp patches, rising or penetrating damp, condensation, black mould, mildew, musty rooms — common on lettings / residential work. NOT: an active leak (Plumbing / Leaks & water ingress).",
    concerto: ["damp", "mould", "condensation"],
    kw: [
      W(/\bdamp\b|\bmou?ld(?:y)?\b|\bcondensation\b|\bmildew\b|\bmusty\b/i, 9),
    ],
    not: [/\bmould(?:ed|ing)\b/i] },

  { id: "brickwork", name: "Brickwork & external walls", group: "Roofs & external",
    description: "Outside walls and structure: brickwork, pointing, render, external cladding, cracks in external walls, spalling concrete, lintels, copings, retaining walls, steps and ramps built into the building, structural concerns. NOT: car parks and paving (Car parks & external surfaces), fascia boards (Roofline & rainwater).",
    concerto: ["external", "external walls", "brickwork", "masonry", "render", "structure"],
    kw: [
      W(/\bbrick(?:work|s)?\b|\bpointing\b|\brender(?:ing)?\b|\bmasonry\b|\blintels?\b|\bcopings?\b|\bretaining wall\b|\bstructural\b|\bspalling\b|\bconcrete\b/i, 7),
      W(/\bramps?\b|\bsteps\b/i, 3),
    ],
    not: [] },

  { id: "decorating", name: "Decorating", group: "Building fabric",
    description: "Painting and finishes: redecoration inside and out, painting walls, ceilings, doors and window frames, flaking or bubbling paintwork, wallpaper, filling and making good before painting, line marking on floors inside. NOT: graffiti removal (Cleaning & waste), car-park line painting (Car parks & external surfaces).",
    concerto: ["decorating", "decoration", "painting", "paintwork"],
    kw: [
      W(/\bpaint(?:ing|work|ed)?\b|\bdecorat|\bre-?paint|\bwall ?paper\b|\bdulux\b|\bemulsion\b|\bgloss\b|\bundercoat\b|\bmaking good\b/i, 7),
    ],
    not: [] },

  /* ── Roofs & external ────────────────────────────────────────────────── */
  { id: "external-surfaces", name: "Car parks & external surfaces", group: "Roofs & external",
    description: "The ground outside: potholes, tarmac and asphalt, block paving and slabs, kerbs, external trip hazards, car-park line marking, speed bumps, external drainage covers that are damaged (not blocked), ramps and paths outside, forecourt surfaces, bollards hit by vehicles. NOT: fencing (Fencing & barriers), blocked outside drains (Drainage).",
    concerto: ["car park", "carpark", "external areas", "external", "paving", "potholes", "forecourt"],
    kw: [
      W(/\bdrain covers?\b|\bpathway\b|\bpaving slabs?\b|\bpot ?holes?\b|\btarmac\b|\basphalt\b|\bcar ?park\b|\bblock paving\b|\bpaving\b|\bslabs?\b|\bkerbs?\b|\bline marking\b|\bspeed bumps?\b|\bbollards?\b|\bforecourt surface\b|\bfootpath\b|\bpavement\b/i, 9),
      W(/\btrip hazard\b.*\b(?:outside|car ?park|path|front)\b|\boutside\b.*\btrip hazard\b/i, 5),
    ],
    not: [] },

  { id: "fencing", name: "Fencing & barriers", group: "Roofs & external",
    description: "Boundary and yard structures: fences and fence panels, posts, railings, walls around bin stores, bin-store enclosures, trolley bays and shelters, cycle racks, handrails outside, crash barriers. NOT: gates and gate motors (Shutters, gates & grilles), bollards in the car park (Car parks & external surfaces).",
    concerto: ["fencing", "fence", "fences", "railings", "bin store", "trolley bay"],
    kw: [
      W(/\bfenc(?:e|es|ing)\b|\bfence panels?\b|\brailings?\b|\bbin stores?\b|\bhand ?rails?\b|\b(?:crash|security) barriers?\b|\bpicket\b/i, 9),
    ],
    not: [] },

  { id: "grounds", name: "Grounds, trees & landscaping", group: "Roofs & external",
    description: "Soft landscaping and grounds maintenance: overgrown trees and branches, hedges, weeds, grass cutting, planters, garden clearance, leaves, fallen trees after a storm, ivy on buildings. NOT: litter and waste clearance (Cleaning & waste), fencing (Fencing & barriers).",
    concerto: ["grounds", "grounds maintenance", "landscaping", "trees"],
    kw: [
      W(/\btrees?\b|\bbranches\b|\bhedges?\b|\bweeds?\b|\bgrass\b|\bplanters?\b|\bgarden\b|\blandscap|\bivy\b|\bovergrown\b|\bshrubs?\b|\bleaves\b/i, 8),
    ],
    not: [] },

  { id: "signage", name: "Signage", group: "Roofs & external",
    description: "Signs as objects: loose, wobbly or fallen signs, fascia signs, totem and pole signs, Post Office and partner signs, safety signs, wayfinding signs, sign brackets and fixings. If the sign's LIGHTS are out it is Lighting. NOT: illuminated sign lighting failures (Lighting), exit signs (Emergency lighting).",
    concerto: ["signage", "signs", "sign", "totem"],
    kw: [
      W(/\bsignage\b|\btotem\b|\bpole sign\b|\bfascia sign\b|\bpost office'?\s+sign\b/i, 7),
      W(/\bsigns?\b/i, 4),
    ],
    not: [/\bexit signs?\b/i, /\bsign(?:ed|ing)? (?:off|in|out)\b/i, /\bsign(?:age)? light|\billuminated sign/i] },

  { id: "street-furniture", name: "External bins & street furniture", group: "Roofs & external",
    description: "Free-standing and fixed items outside the store: litter bins, dog bins, benches, cycle racks and bike shelters, trolley bays and trolley shelters, smoking shelters, planters as fixtures, post boxes and parcel lockers on the forecourt. NOT: cigarette bins and smoking points (General maintenance), fences and railings (Fencing & barriers), waste collections (Cleaning, waste & clearance), car-park surfaces (Car parks & external surfaces).",
    concerto: ["litter bin", "bins", "bench", "cycle rack", "trolley bay", "smoking shelter"],
    kw: [
      W(/\b(?:outside|external|outdoor) bins?\b|\bbins? (?:has been |was |got )?(?:stolen|missing|taken)\b|\blitter bins?\b|\bdog bins?\b|\bbenche?s?\b|\b(?:cycle|bike) (?:rack|shelter|stand)s?\b|\btrolley (?:bay|shelter|park)s?\b|\bparcel lockers?\b/i, 9),
    ],
    not: [] },

  { id: "solar-pv", name: "Solar PV & batteries", group: "Electrical",
    description: "Solar panels and everything that goes with them: PV arrays on the roof, inverters and their alarms or fault lights, PV isolators, generation meters, battery storage, PV maintenance and annual PV inspections. NOT: general electrical faults (Electrical — power, sockets & tripping), EV chargers (Forecourt, fuel & EV charging).",
    concerto: ["solar", "solar panels", "pv", "inverter"],
    kw: [
      W(/\bsolar\b|\bpv\b|\bphoto ?voltaic\b|\binverters?\b|\bbattery storage\b|\bgeneration meter\b/i, 10),
    ],
    not: [] },

  /* ── Fixtures & fittings ─────────────────────────────────────────────── */
  { id: "washroom-fittings", name: "Washroom fittings", group: "Fixtures & fittings",
    description: "Things fixed in toilets and washrooms that aren't plumbing: toilet seats and hinges, hand dryers, soap / paper towel / toilet-roll dispensers, sanitary bins, baby-change units, grab rails and disabled-toilet alarms (pull cords), mirrors, cubicle partitions and their locks. NOT: blocked toilets (Drainage), leaking or non-flushing toilets (Plumbing).",
    concerto: ["hand dryer", "hand dryers", "toilet seat", "washroom", "washrooms", "dispensers", "baby change", "disabled toilet alarm"],
    kw: [
      W(/\btoilet seats?\b|\bseat\b.{0,30}\b(?:hinge|broken|loose)|\bhand ?dryers?\b|\bdispensers?\b|\bsoap\b|\bpaper towel|\btoilet roll holder|\bsanitary bins?\b|\bbaby chang|\bgrab rails?\b|\bpull cord\b|\bdisabled (?:toilet )?alarm\b|\bcubicles?\b|\bcubicals?\b|\bmirrors?\b/i, 9),
    ],
    not: [] },

  { id: "store-fixtures", name: "Store fixtures & shelving", group: "Fixtures & fittings",
    description: "Shopfitting and fixtures in the sales area and warehouse: shelving, gondolas, shelf edges and stock limiters, plastic strips and ticket channels (meal-deal strips), kiosks and counters, tobacco / vape / spirits cabinets (the cabinet, not its lock), lockers, checkouts housings, trolleys and baskets bays, condiment and coffee bars to remove or alter, display stands, cages and racking. NOT: the lock on a cabinet (Locks, keys & access), fridges (Refrigeration), tills and card readers (IT, tills & telecoms).",
    concerto: ["shelving", "shelves", "fixtures", "fixtures & fittings", "plastic shelf stock limiters", "kiosk", "counter", "lockers", "racking", "cabinet"],
    kw: [
      W(/\bbase ?boards?\b|\bkick ?boards?\b|\bshelf edges?\b|\bgantry\b|\bnewspaper (?:stand|storage)\b|\bshel(?:f|ves|ving)\b|\bgondolas?\b|\bstock limiters?\b|\bticket (?:strip|channel)s?\b|\bplastic strip|\bmeal deal\b|\bkiosks?\b|\bcounters?\b|\blockers?\b|\bracking\b|\bdisplay (?:stand|unit)s?\b|\bcondiment\b/i, 7),
      W(/\bcabinets?\b/i, 4),
      W(/\b(?:vape|tobacco|spirits|cigarette|coffee|display|cabinet|kiosk|counter) (?:cabinet )?doors?\b|\bdoors? (?:of|on) the (?:[\w-]+ )?(?:cabinet|kiosk|counter)s?\b|\b(?:vape|tobacco|spirits|cigarette|display) cabinets?\b/i, 6),
    ],
    not: [/\bkey ?cabinet\b/i] },

  { id: "joinery", name: "Joinery & carpentry", group: "Fixtures & fittings",
    description: "Timber work and fitted furniture: kitchen units and worktops (supply / fit / repair), cupboard doors and drawers, skirting and architrave, boxing in, timber frames and battens, timber repairs to rotten window boards, stud work, bespoke joinery. NOT: shop shelving and gondolas (Store fixtures & shelving), doors and their closers (Doors).",
    concerto: ["joinery", "carpentry", "worktop", "kitchen units", "cupboards"],
    kw: [
      W(/\bjoiner(?:y)?\b|\bcarpent(?:ry|er)\b|\btimber\b|\bworktops?\b|\bkitchen units?\b|\bbase units?\b|\bwall units?\b|\bcupboards?\b|\bdrawers?\b|\bskirting\b|\barchitrave\b|\bboxing\b|\bwooden\b|\bwood\b|\bply(?:wood)?\b|\brotten\b/i, 6),
    ],
    not: [] },

  /* ── Equipment & systems ─────────────────────────────────────────────── */
  { id: "catering-appliances", name: "Catering & appliances", group: "Equipment & systems",
    description: "Appliances and catering kit: bake-off and bakery ovens, provers, hot cabinets and hot-food counters, coffee machines (Starbucks / Costa express), microwaves, kettles, toasters, dishwashers, glass washers, cookers, ovens and hobs in flats (electric), washing machines, white goods. NOT: gas cookers / hobs (Gas), fridges and freezers (Refrigeration), water heaters and boiling-water taps (Hot water).",
    concerto: ["bakery", "oven", "ovens", "coffee machine", "catering equipment", "hot food", "appliances", "cooker", "hob"],
    kw: [
      W(/\bwater coolers?\b|\bwater dispensers?\b|\bovens?\b|\bprovers?\b|\bbake[- ]?off\b|\bhot (?:cabinet|counter|food|plate|hold)\b|\bcoffee machines?\b|\bcosta\b|\bmicrowaves?\b|\bkettles?\b|\btoasters?\b|\bdish ?washers?\b|\bglass ?washers?\b|\bcookers?\b|\bhobs?\b|\bwashing machines?\b|\bwhite goods\b|\bextractor hood\b/i, 8),
    ],
    not: [] },

  { id: "it-telecoms", name: "IT, tills & telecoms", group: "Equipment & systems",
    description: "Store systems and data: tills / EPOS, self-checkouts (SCO), card readers and PIN pads, PayPoint, scales and label printers, phones and phone lines, broadband / network, Wi-Fi access points, data cabling (Cat5/Cat6) and comms cabinets, printers, back-office PCs, music and tannoy systems. Usually routed to the IT supplier. NOT: no power to the till circuit (Electrical — power, sockets & tripping).",
    concerto: ["it", "epos", "till", "tills", "telephony", "phones", "network", "data", "scales", "self checkout", "card reader"],
    kw: [
      W(/\b(?:till|safe) (?:door|safe)\b|\btill safe\b/i, -8),
      W(/\bpcs?\b|\bcomputers?\b|\blaptops?\b|\boffline\b/i, 4),
      W(/\btills?\b|\bepos\b|\bself[- ]?check ?outs?\b|\bsco ?\d*\b|\binternet\b|\bethernet\b|\blog ?in\b|\boutlook\b|\bpasswords?\b|\bemail address\b|\bqueu(?:e|ing) system\b|\brouter\b|\bups\b|\bscanners?\b|\btablet\b|\bcard (?:machine|reader|terminal)s?\b|\bpin ?pads?\b|\bpay ?point\b|\bscales?\b|\blabel printers?\b|\bprinters?\b|\bphones?\b|\bphone line\b|\bring out\b|\bbroadband\b|\bnetwork\b|\bwi-?fi\b|\baccess points?\b|\bap\d\b|\bcat ?[56]e?\b|\bdata (?:point|cable|cabling)\b|\bcomms\b|\btannoy\b|\bmusic system\b|\bnetwork switch\b|\baruba\b|\bports? \d+|\bpatch (?:panel|lead)s?\b|\bgateways?\b/i, 8),
    ],
    not: [] },

  { id: "lifts", name: "Lifts & hoists", group: "Equipment & systems",
    description: "Goods lifts, passenger lifts, platform and stair lifts, dumb waiters, hoists, lift alarms and lift phones, LOLER inspections. NOT: lift lighting (Lighting).",
    concerto: ["lift", "lifts", "goods lift", "hoist", "platform lift"],
    kw: [
      W(/\b(?:goods |passenger |platform |stair ?)?lifts?\b(?! (?:up|off|the))|\bhoists?\b|\bdumb ?waiter\b|\bloler\b/i, 8),
    ],
    not: [/\blift(?:ing|ed)\b/i, /\btiles?\b/i] },

  { id: "forecourt-ev", name: "Forecourt, fuel & EV charging", group: "Equipment & systems",
    description: "Petrol-forecourt (PFS) equipment: fuel pumps and dispensers, nozzles and hoses, tank gauges and wet-stock alarms, interceptor alarms, canopy structure, AdBlue, air and water machines, car washes, EV chargers and charging bays. Canopy LIGHTS are Lighting. NOT: forecourt surfaces and potholes (Car parks & external surfaces), canopy lighting (Lighting).",
    concerto: ["forecourt", "forecourt/canopy", "fuel", "pumps", "ev charger", "ev chargers", "car wash", "air machine"],
    kw: [
      W(/\bfuel\b|\bpetrol\b|\bdiesel\b|\b(?:fuel|pump|petrol|diesel) nozzles?\b|\bfuel pumps?\b|\bdispensers?\b.*\bfuel|\bcanopy\b|\badblue\b|\bair (?:and water )?machine\b|\bcar ?wash\b|\bev (?:charg|point)|\bcharging (?:bay|point)s?\b|\btank gauge\b|\bwet ?stock\b|\bdoms\b|\bforecourt\b|\bjet ?wash (?:bay|machine)\b/i, 9),
    ],
    not: [] },

  { id: "pumps-plant", name: "Pumps & plant", group: "Equipment & systems",
    description: "Mechanical plant that isn't heating or cooling: sump and pump-station pumps, booster pumps, sewage pump stations and their alarms, cold-water booster sets, generators, compressors for non-refrigeration use, plant-room equipment generally. NOT: a blocked drain or Saniflo (Drainage), refrigeration plant (Refrigeration).",
    concerto: ["pumps", "pump", "sump pump", "plant", "generator", "booster"],
    kw: [
      W(/\bsump\b|\bpump ?(?:station|room)\b|\bbooster (?:pump|set)s?\b|\bgenerators?\b|\bplant ?room\b|\bpumps?\b/i, 7),
    ],
    not: [/\bfuel pumps?\b|\bwaste pump\b/i] },

  /* ── Hygiene & environment ───────────────────────────────────────────── */
  { id: "pest-control", name: "Pest control & proofing", group: "Hygiene & environment",
    description: "Pests and keeping them out: rats, mice, rodent droppings, cockroaches, flies, wasps' nests, pigeons and birds (netting, spikes), proofing gaps around pipes, doors and chillers to stop entry, cleaning and sterilising after an infestation (e.g. rat excrement in hatches), work recommended by Rentokil / pest contractors. NOT: fly zappers / insect killers (Electrical — power),  rats coming up through drains (Drainage), fire-stopping gaps (Firestopping).",
    concerto: ["pest control", "pests", "pest", "proofing", "rodents", "birds"],
    kw: [
      W(/\bfly (?:control(?! units?)|screens?)\b|\bfruit fl(?:y|ies)\b|\bpests?\b|\brodents?\b|\brats?\b|\bmice\b|\bmouse\b|\bvermin\b|\bdroppings\b|\bcockroach|\binfest|\bwasps?\b|\bflies\b|\bpigeons?\b|\bbird (?:netting|spikes|mesh)\b|\bbirds?\b|\brentokil\b|\bproof(?:ing|ed)?\b|\bsteril(?:is|iz)/i, 9),
      W(/\bgaps?\b.{0,40}\b(?:entry|enter|getting in)\b|\bprevent (?:the )?entry\b|\bplug (?:the |a )?holes?\b|\bstop (?:them|rodents|pests|mice|rats) (?:getting|coming) in\b/i, 7),
    ],
    not: [/\bwater ?proof|\bfire ?proof|\bweather ?proof/i] },

  { id: "cleaning-waste", name: "Cleaning, waste & clearance", group: "Hygiene & environment",
    description: "Cleaning and rubbish rather than repairs: graffiti removal, jet / pressure washing, deep cleans, cleaning up after a leak or flood, chewing gum removal, litter, fly-tipping, site and warehouse clearance (cages of metal / plastic / mixed waste), skips, urgent general-waste collections, removing redundant equipment for disposal. NOT: pest sterilisation (Pest control & proofing), garden clearance (Grounds, trees & landscaping).",
    concerto: ["general waste", "waste", "cleaning", "graffiti", "clearance", "fly tipping"],
    kw: [
      W(/\bfly[- ]?tip(?:ping|ped)?\b/i, 10),
      W(/\bcleaned\b|\bdeep clean\b|\bclean(?:ed)? (?:up|the|down|off)\b|\bneeds? (?:a )?clean(?:ing)?\b|\bto be cleaned\b|\btip collection\b|\bgraffiti\b|\bjet ?wash|\bpressure wash|\bdeep clean\b|\bchewing gum\b|\blitter\b|\bfly[- ]?tip|\bclearance\b|\bskips?\b|\brubbish\b|\bwaste collection\b|\bdispos(?:e|al)\b|\bremove and dispose\b/i, 7),
    ],
    not: [] },

  /* ── Compliance & surveys ────────────────────────────────────────────── */
  { id: "surveys-inspections", name: "Surveys, inspections & quotes", group: "Compliance & testing",
    description: "Visits to look and report, not fix: site surveys, condition surveys, H&S audit actions to assess, asbestos surveys, dilapidations, measure-ups, 'please quote for…', photographs requested of consumer units / store areas, fire risk assessments. NOT: the works that follow (the matching type), EICRs (Electrical testing & certificates), gas safety certificates (Gas).",
    concerto: ["survey", "surveys", "inspection", "quote", "quotation", "asbestos"],
    kw: [
      W(/\bsurvey\b|\binspection\b|\binspect\b|\bquot(?:e|ation)\b|\bmeasure[- ]?up\b|\bdilapidation|\basbestos\b|\bassess(?:ment)?\b|\baudit\b|\bsupply pictures\b|\bphotos? of\b/i, 5),
    ],
    not: [] },

  /* ── Other ───────────────────────────────────────────────────────────── */
  { id: "logistics", name: "Logistics & admin (not a site fault)", group: "Other",
    description: "Internal tasks booked as jobs: delivering or collecting materials, picking up from merchants, dropping kit at site, deliveries such as ECO boxes, vehicle MOTs and services, van swaps, travel (ferries), staff days off and holidays booked onto the board, office and yard tasks. Kept separate so they don't pollute fault statistics.",
    concerto: [],
    kw: [
      W(/^\s*(?:please )?(?:deliver|collect|pick ?up|drop(?: off)?|go to)\b|\bready to collect\b|\bmaterials for\b|\bcollect (?:all|the following|\d)|\bdeliver materials\b|\braise po (?:number )?through (?:this )?job\b|\bdeliver (?:eco|the)\b|\beco ?box\b|\bcollect (?:materials|from)|\bpick up\b|\bdrop materials\b|\bmot\b|\bvan (?:booked|service|swap)|\bswap vans\b|\bferry\b|\bday off\b|\bholiday\b|\boff (?:monday|tuesday|wednesday|thursday|friday)\b/i, 9),
    ],
    not: [] },

  { id: "general", name: "General maintenance", group: "Other",
    description: "Small mixed repairs that don't fit one trade, or a list of several different small jobs for a handyman visit: put up a notice board, re-fix a bracket, adjust something, 'various' works. Also cigarette bins / smoking points (broken, missing, replace), and admin requests that aren't a repair (e.g. setting up an email for a new manager). Use this only when no other type fits.",
    concerto: ["cigarette bin", "cigarette bins", "smoking shelter", "general", "general maintenance", "work required", "other", "miscellaneous"],
    kw: [W(/\bvarious\b|\bodd jobs?\b|\bhandyman\b|\bgeneral (?:maintenance|repairs?)\b|\bre-?fix\b|\bbrackets?\b/i, 2),
      W(/\bcig(?:arette)? bins?\b|\bsmoking (?:point|shelter|bin)s?\b|\bbutt bins?\b|\bcigarette butts\b/i, 9),
      W(/\bemails?\b.{0,20}\bset ?up\b|\bset ?up\b.{0,30}\bemails?\b|\bholding manager\b/i, 12)],
    not: [] },
];

export const WORK_TYPE_BY_ID = Object.fromEntries(WORK_TYPES.map(t => [t.id, t]));

/* Old work-area ids (the 9 defaults before Oct 2026) → the new types they covered.
   Used to migrate engineer skill stars + subcontractor coverage, and to read a job
   still carrying an old workArea id. The FIRST entry is the "main" new type. */
export const LEGACY_AREA_MAP = {
  "electrical": ["electrical-power", "lighting", "emergency-lighting", "electrical-testing", "it-telecoms"],
  "plumbing": ["plumbing", "hot-water", "water-hygiene", "drainage"],
  "fabric-building": ["walls-plaster", "ceilings", "flooring", "leaks-ingress", "brickwork", "damp-mould", "roofing", "rainwater", "glazing", "external-surfaces"],
  "firestopping": ["firestopping"],
  "fire-alarms": ["fire-alarms", "fire-doors"],
  "heating-hvac": ["heating", "air-con", "ventilation", "refrigeration"],
  "joinery-carpentry": ["joinery", "doors", "store-fixtures", "washroom-fittings"],
  "decorating": ["decorating"],
  "general-maintenance": ["general", "locks-access", "make-safe", "washroom-fittings", "store-fixtures", "fencing", "signage", "cleaning-waste"],
};

/* Concerto prefixes the fault text with its own tag: "Drains : Blocked (R, E) - …".
   Returns {asset, fault, codes} or null. Tolerates the tag anywhere near the start
   (the email intake keeps it; Zapier-era jobs lost it). */
export function concertoTag(text) {
  const t = String(text || "");
  const m = /(?:^|\n|Fault\/Issue:\s*|Description:<\/b>\s*|:\s)\s*([A-Za-z][A-Za-z0-9 &\/'().-]{1,40}?)\s+:\s+([A-Za-z][A-Za-z0-9 &\/'.-]{1,50}?)\s*\(([A-Z][A-Za-z ,]{0,20})\)/.exec(t.slice(0, 600));
  if (!m) return null;
  return { asset: m[1].trim(), fault: m[2].trim(), codes: m[3].trim(), raw: m[0] };
}

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9/& ]+/g, " ").replace(/\s+/g, " ").trim();
const CONCERTO_INDEX = (() => {
  const m = new Map();
  for (const t of WORK_TYPES) for (const a of t.concerto || []) if (!m.has(norm(a))) m.set(norm(a), t.id);
  return m;
})();

/* Map a Concerto tag to a type. Asset decides, but some assets are generic
   ("Toilets", "System", "External") and the FAULT says which trade it is. */
export function typeFromConcertoTag(tag) {
  if (!tag) return null;
  const a = norm(String(tag.asset || "").replace(/\([^)]*\)/g, "")), f = norm(tag.fault);
  // generic assets — the fault or the description decides
  // Concerto files ANY door under "Fire Door" (handles, closers, warehouse doors) — a
  // weak pointer to Doors; the text saying "fire door / fire exit" still wins.
  if (/^(?:fire door|fire doors)$/.test(a)) return "doors";
  if (/^(?:system|external|external areas|not working|leaking|temperature issues?|recommendation|internal|ceiling)$/.test(a)) {
    if (a === "recommendation" && /proof/.test(f)) return "pest-control";
    if (a === "internal" && /clean/.test(f)) return "cleaning-waste";
    if (a === "ceiling") return /leak|water/.test(f) ? "leaks-ingress" : /tile/.test(f) ? "ceilings" : null;
    if (a === "system" && /supply tripped|tripp/.test(f)) return "electrical-power";
    return null;
  }
  if (/^(?:toilets?|wc|urinals?|sinks?|basins?)$/.test(a)) {
    if (/block|single toilet|no toilets|not draining|overflow|smell|odou?r/.test(f)) return "drainage";
    if (/seat|dryer|dispenser|cubicle|lock|alarm|cord/.test(f)) return "washroom-fittings";
    return "plumbing";
  }
  if (a === "blocked") return "drainage";
  if (/^(?:all lights|lights?|strip lights?|spot ?lights?|light switch|timer|forecourt\/canopy)$/.test(a) || (/forecourt|canopy/.test(a) && /light/.test(f))) return "lighting";
  if (a === "auto door") return /glass|smash|crack/.test(f) ? "glazing" : "automatic-doors";
  if (/^(?:metal door|wooden door|mortuary)$/.test(a)) return "doors";
  if (a === "kiosk door") return /lock|key/.test(f) ? "locks-access" : "store-fixtures";
  if (a === "lockers") return /lock|key/.test(f) ? "locks-access" : "store-fixtures";
  if (/^(?:cables\/wiring|cables|wiring|sockets?)$/.test(a)) return "electrical-power";
  if (/^gas boiler$/.test(a)) return "gas";
  if (/^(?:fly zapper|insecutor|fly killer)$/.test(a)) return "electrical-power";
  if (/^(?:equipment collection|general waste)$/.test(a)) return "cleaning-waste";
  if (/^(?:car park|foot ?path)$/.test(a)) return "external-surfaces";
  if (/^(?:queuing systems?|store phone|site network|doms?)$/.test(a)) return a.startsWith("dom") ? "forecourt-ev" : "it-telecoms";
  if (/^(?:smoke cloak)$/.test(a)) return "security-systems";
  if (/^(?:fire signage)$/.test(a)) return "signage";
  if (/^(?:newspaper storage|counter|shelving)$/.test(a)) return "store-fixtures";
  if (/^(?:dishwasher|unox.*|oven)$/.test(a)) return "catering-appliances";
  if (/^(?:jet wash)$/.test(a)) return "forecourt-ev";
  if (/^pat$/.test(a)) return "electrical-testing";
  if (/^(?:asbestos|survey)$/.test(a)) return "surveys-inspections";
  if (/^(?:air con unit)$/.test(a)) return "air-con";
  if (/^(?:walls?)$/.test(a)) return "walls-plaster";
  if (/^(?:flooring)$/.test(a)) return /leak/.test(f) ? null : "flooring";
  if (/^(?:windows?)$/.test(a)) return "glazing";
  if (/^(?:roof)$/.test(a)) return "roofing";
  if (/^(?:guttering)$/.test(a)) return "rainwater";
  if (/^(?:saniflow|saniflo)$/.test(a)) return "drainage";
  if (/^(?:cigarette bins?|smoking shelter)$/.test(a)) return "general";
  if (CONCERTO_INDEX.has(a)) return CONCERTO_INDEX.get(a);
  for (const [k, id] of CONCERTO_INDEX) if (k.length > 3 && (a.startsWith(k) || k.startsWith(a))) return id;
  return null;
}

/* Words that only say WHERE the fault is must not decide WHAT it is: "light by the
   back-up chiller" is a lighting job, "tiles raised on the shop floor by the chillers"
   is flooring. Strip "by / next to / behind / … the <thing>" phrases, and the Co-op's
   own location words ("shop floor", "sales floor", "branch"), before scoring. */
export function stripLocations(t) {
  return String(t || "")
    .replace(/\b(?:shop|sales|retail) floor\b|\btill (?:area|point|bank)\b/gi, " store ")
    .replace(/\b(?:on the back of|on back of|the back of|by|next to|near|nearest|nearest to|closest to|nearby|behind|beside|besides|alongside|around|round|underneath|beneath|opposite|in front of)(?:\/(?:behind|under|underneath|beside|by))?\s+(?:the |our |a |an |them |it |to the )?(?:back ?up |main |old |new |small |large |big |front |rear |left |right |top |bottom |customer |colleague |staff )?[\w-]+(?:\s+(?:area|section|machines?|units?|room|door|aisle|isle))?/gi, " ")
    .replace(/\b(?:outside|under|above|below)\s+(?:the |our |a |an )(?:back ?up |main |old |new |front |rear |customer |colleague |staff )?[\w-]+(?:\s+(?:area|section|machines?|units?|room|door|aisle|isle))?/gi, " ");
}

const TAG_PRIOR = 6;

/* Score every type against the text. Returns the best (with runner-ups) or null. */
export function classifyWork(text, opts = {}) {
  const raw = String(text || "");
  if (!raw.trim()) return null;
  const tag = concertoTag(raw);
  let fromTag = typeFromConcertoTag(tag);
  // a "Sockets" / "Cables/Wiring" tag on a DATA problem is an IT job, not power
  if (fromTag === "doors" && tag && /^fire/i.test(tag.asset) && /\bfire (?:exit |escape )?doors?\b|\bfire exits?\b|\bpanic bar|\bintumescent|\bsmoke seal/i.test(raw.replace(tag.raw, " "))) fromTag = "fire-doors";
  if (fromTag === "electrical-power" && /\b(?:data|ethernet|internet|network|wall ?ports?|dsl|cat ?[56]e?|router|broadband|wi-?fi|printers?|scanners?|tills?|card (?:reader|machine)s?|label)\b/i.test(raw)) fromTag = "it-telecoms";
  // strip boilerplate that matches nothing useful but trips keywords
  // score the DESCRIPTION only — the tag's own words ("Fire Door : Door Closer") would
  // otherwise vote for the tag's trade a second time, even when the text disagrees
  const body = tag ? raw.replace(tag.raw, " ") : raw;
  const t = stripLocations(body.replace(/ACCESS TIMES?\s*:[\s\S]*$/i, " ").replace(/\b(?:please|thanks?|thank you|good (?:morning|afternoon|evening))\b/gi, " "));
  const scores = [];
  for (const wt of WORK_TYPES) {
    if (wt.not.some(re => re.test(t))) continue;
    let s = 0;
    for (const [re, w] of wt.kw) if (re.test(t)) s += w;
    if (s > 0) scores.push({ id: wt.id, score: s });
  }
  scores.sort((a, b) => b.score - a.score);
  const pick = (id, score, source) => { const wt = WORK_TYPE_BY_ID[id]; return { id, name: wt.name, group: wt.group, score, source, tag, alts: scores.filter(x => x.id !== id).slice(0, 3) }; };
  // Concerto's tag is a PRIOR, not the answer: 495 real jobs showed it is often
  // generic or wrong ("System : No Power" on a till, "Fire Door" on any door,
  // "Asbestos" on a bin complaint). It adds weight; the description decides.
  if (fromTag) {
    const hit = scores.find(x => x.id === fromTag);
    if (hit) hit.score += TAG_PRIOR; else scores.push({ id: fromTag, score: TAG_PRIOR });
    scores.sort((a, b) => b.score - a.score);
  }
  const min = opts.minScore == null ? 4 : opts.minScore;
  if (!scores.length || scores[0].score < min) return null;
  const top = scores[0];
  return pick(top.id, top.score, fromTag && fromTag === top.id ? "concerto+text" : "keywords");
}

/* The type list for a prompt: "id — name: description" lines. */
export function workTypesPrompt(types = WORK_TYPES) {
  return types.map(t => `- ${t.id} — ${t.name} [${t.group}]: ${t.description}`).join("\n");
}
