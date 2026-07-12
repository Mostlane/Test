// Mostlane RAMS hazard/control library + risk matrix.
// ---------------------------------------------------------------------------
// Powers the Risk Assessment Builder (hs-docs.html). Modelled on the THSP
// "Risk Assessment Builder" format: every hazard carries a WITHOUT-controls
// severity×likelihood and, after its control measures, a WITH-controls
// (residual) severity×likelihood. Risk rating = severity × likelihood.
//
// STRUCTURE
//   HS_RAMS.severityKey / likelihoodKey / riskControlPlan  — the standard keys.
//   HS_RAMS.hazards      — id → { name, persons[], sevWithout, likWithout,
//                                 controls[], sevWith, likWith }
//   HS_RAMS.workTypes    — the selection tree: work type → sub-category →
//                          sub-type, each sub-type listing the hazard ids it
//                          brings in. Selecting sub-types assembles a deduped
//                          hazard list, pre-filled and then editable.
//
// This is a shared starter library; an in-app editor (and per-tenant overrides)
// come in a later step. Grow it by adding to `hazards` and referencing the ids
// under the relevant sub-types.
window.HS_RAMS = (function () {
  const severityKey = [
    "Trivial / minor injury",
    "Moderate injury / minor property damage",
    "Major injury to one person / short-term health effects",
    "Major injury to several people / long-term health effects / major property damage",
    "Fatality",
  ];
  const likelihoodKey = [
    "Improbable occurrence",
    "Remote occurrence",
    "Possible occurrence",
    "Probable occurrence",
    "Likely occurrence",
  ];
  const riskControlPlan = [
    { band: "LOW (1-6)", text: "No action is required and no documentary records need to be kept. Monitoring is required to ensure that the controls remain effective." },
    { band: "MEDIUM (8-12)", text: "Efforts must be made to reduce the risk but the cost of prevention should be carefully measured. Risk reduction measures should be implemented within a defined time period. Where the medium risk is associated with extremely harmful consequences, further assessment may be necessary to establish more precisely the likelihood of harm." },
    { band: "HIGH (15-25)", text: "Work should not be started until the risk has been reduced. Considerable resources may have to be allocated to reduce the risk. Where the risk involves work in progress, urgent action should be taken. If it is not possible to reduce the risk, even with unlimited resources, work has to remain prohibited." },
  ];

  // Risk = severity × likelihood, banded exactly as THSP.
  function band(sev, lik) {
    const r = (Number(sev) || 0) * (Number(lik) || 0);
    if (r >= 15) return "High";
    if (r >= 8) return "Medium";
    return "Low";
  }

  const P_STD = ["Operative", "Supervisor", "Third Party", "Members of the public"];

  // ── Hazard library ────────────────────────────────────────────────────────
  const hazards = {
    electricity: {
      name: "Contact with electricity",
      persons: ["Operative", "Apprentice", "Third Party"],
      sevWithout: 5, likWithout: 5,
      controls: [
        "Only suitably trained, competent and authorised persons carry out electrical work, working to BS 7671 and the Electricity at Work Regulations 1989.",
        "Circuits are safely isolated, proved dead with a proprietary voltage indicator (proved on a known source before and after), and locked off with a personal lock and warning label before work begins.",
        "All portable electrical tools and leads are inspected before use for damage; defective items are removed from use immediately, reported and quarantined.",
        "Suitable insulated tools and PPE are used; 110V or battery equipment is used on site in preference to 230V.",
      ],
      sevWith: 5, likWith: 1,
    },
    electricity_live: {
      name: "Live electrical working",
      persons: ["Operative", "Apprentice"],
      sevWithout: 5, likWithout: 5,
      controls: [
        "Live working is avoided; work is only carried out live where it is unreasonable to work dead AND a documented live-working risk assessment/permit is in place.",
        "A competent person uses insulated tools, insulated matting, appropriate arc-rated PPE and works with an accompanying person present.",
        "Adjacent live parts are guarded or made dead; barriers and warning signage are positioned.",
      ],
      sevWith: 5, likWith: 2,
    },
    arc_flash: {
      name: "Arc flash / burns",
      persons: ["Operative", "Apprentice"],
      sevWithout: 5, likWithout: 4,
      controls: [
        "Equipment is isolated and proved dead before work; where live testing is unavoidable, arc-rated face/hand protection and clothing are worn.",
        "Working space, access and lighting are adequate; tools are insulated and in good condition.",
      ],
      sevWith: 5, likWith: 1,
    },
    work_height_mewp: {
      name: "Fall of person / object from height (MEWP)",
      persons: ["Operative", "Apprentice", "Third Party"],
      sevWithout: 5, likWithout: 4,
      controls: [
        "MEWP operated only by IPAF-certified, competent operators; daily pre-use checks recorded and LOLER thorough examination in date.",
        "Harness and adjustable lanyard worn and clipped to the designated anchor in boom-type platforms; ground conditions assessed and outriggers used as required.",
        "Exclusion zone established beneath the work area; a trained ground/rescue person is present with a rescue plan.",
      ],
      sevWith: 5, likWith: 1,
    },
    work_height_ladder: {
      name: "Fall from height (ladders / steps)",
      persons: ["Operative", "Apprentice"],
      sevWithout: 4, likWithout: 4,
      controls: [
        "Ladders used only for short-duration, low-risk work; a suitable working platform is used in preference where practicable.",
        "Ladders/steps are inspected before use, sound, on firm level ground, secured/footed, and used at the correct angle with three points of contact maintained.",
      ],
      sevWith: 4, likWith: 1,
    },
    work_height_tower: {
      name: "Fall from height (mobile tower / scaffold)",
      persons: ["Operative", "Apprentice"],
      sevWithout: 5, likWithout: 4,
      controls: [
        "Mobile towers erected by PASMA-trained persons to manufacturer's instructions, with guardrails, toe-boards and outriggers; inspected and tag-signed before use and after any alteration.",
        "Tower is not moved with persons/materials on it; wheels locked when in use.",
      ],
      sevWith: 5, likWith: 1,
    },
    falling_objects: {
      name: "Strike by falling object",
      persons: P_STD,
      sevWithout: 5, likWithout: 3,
      controls: [
        "Exclusion zones, barriers and signage established beneath overhead work; tools and materials secured/tethered and not left at height.",
        "Hard hats worn within the work area; materials raised/lowered by suitable means, never thrown.",
      ],
      sevWith: 5, likWith: 1,
    },
    fragile_surfaces: {
      name: "Fall through fragile surface",
      persons: ["Operative", "Apprentice"],
      sevWithout: 5, likWithout: 4,
      controls: [
        "Fragile surfaces (roof lights, old roof sheets) identified and clearly marked; access prevented by covers, guardrails or staging boards.",
        "Work planned to avoid walking on fragile surfaces; crawling boards and edge protection used where access is unavoidable.",
      ],
      sevWith: 5, likWith: 1,
    },
    excavation_collapse: {
      name: "Excavation collapse / fall into excavation",
      persons: ["Operative", "Site Foreman", "Engineer"],
      sevWithout: 5, likWithout: 4,
      controls: [
        "All excavations assessed daily by a competent person and the inspection recorded; battering, stepping or trench support installed where depth/ground conditions require.",
        "No person enters an unsupported excavation over 1.2m deep; edge protection / barriers and access ladders provided.",
        "Spoil heaps, plant and materials kept back from the excavation edge.",
      ],
      sevWith: 5, likWith: 1,
    },
    underground_services: {
      name: "Contact with underground services",
      persons: ["Operative", "Site Foreman", "Third Party"],
      sevWithout: 5, likWithout: 4,
      controls: [
        "Utility drawings obtained and a CAT & Genny survey completed before breaking ground; findings marked up on the surface.",
        "Safe digging practices followed — hand-dig / vacuum excavation within 500mm of marked services; no mechanical excavation over known services.",
      ],
      sevWith: 5, likWith: 1,
    },
    plant_pedestrian: {
      name: "Plant / pedestrian interface",
      persons: P_STD.concat(["Site Foreman"]),
      sevWithout: 5, likWithout: 4,
      controls: [
        "Segregated pedestrian and plant routes established with barriers; plant fitted with working lights, beacons and reversing alarms.",
        "Plant operated only by CPCS/NPORS-certified operators; banksman used for reversing/blind spots; exclusion zones around slewing plant.",
      ],
      sevWith: 5, likWith: 1,
    },
    overturning: {
      name: "Plant overturn",
      persons: ["Operative", "Site Foreman"],
      sevWithout: 5, likWithout: 3,
      controls: [
        "Ground assessed for bearing capacity; plant operated within its rated capacity on stable, level ground with outriggers where fitted.",
        "ROPS/FOPS and seatbelts in use; loads kept low when travelling.",
      ],
      sevWith: 5, likWith: 1,
    },
    lifting_ops: {
      name: "Lifting operations",
      persons: ["Operative", "Site Foreman", "Third Party"],
      sevWithout: 5, likWithout: 3,
      controls: [
        "Lift planned by a competent Appointed Person; lifting accessories certified (LOLER, in date) and inspected before use.",
        "Exclusion zone under the load; no person passes/stands beneath a suspended load; trained slinger/signaller directs the lift.",
      ],
      sevWith: 5, likWith: 1,
    },
    wet_concrete: {
      name: "Wet concrete (burns / dermatitis)",
      persons: ["Operative", "Site Foreman"],
      sevWithout: 3, likWithout: 3,
      controls: [
        "Impervious gloves, waterproof trousers/boots and eye protection worn; skin contact avoided and washed off promptly.",
        "Welfare/washing facilities available on site; barrier cream and eye-wash provided.",
      ],
      sevWith: 3, likWith: 1,
    },
    manual_handling: {
      name: "Manual handling",
      persons: ["Operative", "Apprentice"],
      sevWithout: 3, likWithout: 4,
      controls: [
        "Mechanical aids (trolleys, teleporter, genie) used in preference to manual lifting; loads assessed and split where possible.",
        "Team lifts used for awkward/heavy items; operatives trained in safe manual-handling technique.",
      ],
      sevWith: 3, likWith: 1,
    },
    slips_trips: {
      name: "Slips, trips and falls",
      persons: P_STD,
      sevWithout: 3, likWithout: 4,
      controls: [
        "Good housekeeping maintained; leads/hoses routed off walkways or covered; work areas kept clear of offcuts and materials.",
        "Adequate lighting provided; spillages cleaned immediately; suitable footwear worn.",
      ],
      sevWith: 3, likWith: 1,
    },
    noise_vibration: {
      name: "Noise and vibration",
      persons: ["Operative", "Site Foreman"],
      sevWithout: 3, likWithout: 3,
      controls: [
        "Low-vibration/low-noise tools selected; trigger/exposure times managed and job rotation used to stay within EAV/ELV limits.",
        "Hearing protection worn in designated zones; anti-vibration gloves provided where appropriate.",
      ],
      sevWith: 3, likWith: 1,
    },
    dust: {
      name: "Exposure to dust (incl. silica)",
      persons: ["Operative", "Apprentice", "Third Party"],
      sevWithout: 4, likWithout: 4,
      controls: [
        "Dust suppressed at source using water or on-tool extraction (M/H-class); dry cutting avoided.",
        "Suitable RPE (FFP3, face-fit tested) and eye protection worn; area ventilated and others kept clear.",
      ],
      sevWith: 4, likWith: 1,
    },
    coshh: {
      name: "Hazardous substances (COSHH)",
      persons: ["Operative", "Apprentice"],
      sevWithout: 3, likWithout: 3,
      controls: [
        "COSHH assessment completed for each substance; safety data sheets held on site and least-hazardous product selected.",
        "Correct PPE (gloves/RPE/eye protection) worn; substances stored, used and disposed of per the SDS; spill kit available.",
      ],
      sevWith: 3, likWith: 1,
    },
    asbestos: {
      name: "Exposure to asbestos",
      persons: ["Operative", "Apprentice", "Third Party", "Members of the public"],
      sevWithout: 4, likWithout: 5,
      controls: [
        "Asbestos identified via the client's asbestos register / refurbishment & demolition survey before work; ACMs clearly marked.",
        "Work planned to avoid disturbing ACMs; if suspected material is found, work stops immediately and is reported — licensed removal arranged where required.",
      ],
      sevWith: 4, likWith: 1,
    },
    biological_drainage: {
      name: "Biological hazard (drainage / foul water)",
      persons: ["Operative", "Site Foreman"],
      sevWithout: 3, likWithout: 3,
      controls: [
        "Impervious gloves and eye protection worn; cuts covered; hands washed before eating and welfare facilities used.",
        "No eating/drinking/smoking in the work area; vaccination status (e.g. tetanus) considered.",
      ],
      sevWith: 3, likWith: 1,
    },
    confined_space: {
      name: "Confined space",
      persons: ["Operative", "Site Foreman"],
      sevWithout: 5, likWithout: 4,
      controls: [
        "Confined-space entry avoided where possible; where unavoidable, a permit-to-work, atmosphere testing, forced ventilation and a trained top-man with rescue plan/equipment are in place.",
        "Only trained, competent persons enter; continuous gas monitoring and communications maintained.",
      ],
      sevWith: 5, likWith: 1,
    },
    hot_works: {
      name: "Hot works (fire)",
      persons: P_STD,
      sevWithout: 5, likWithout: 3,
      controls: [
        "A Hot Works Permit is raised; combustibles removed/protected within 10m and a suitable fire extinguisher is to hand.",
        "A fire watch is maintained during the works and for at least 60 minutes afterwards, and the area re-inspected before leaving.",
      ],
      sevWith: 5, likWith: 1,
    },
    fire_general: {
      name: "Fire",
      persons: P_STD,
      sevWithout: 4, likWithout: 3,
      controls: [
        "Good housekeeping; flammable materials stored safely and quantities on site minimised; ignition sources controlled.",
        "Suitable extinguishers available and site fire/emergency arrangements briefed to all.",
      ],
      sevWith: 4, likWith: 1,
    },
    fumes: {
      name: "Welding / soldering fumes",
      persons: ["Operative", "Apprentice"],
      sevWithout: 3, likWithout: 3,
      controls: [
        "Local exhaust ventilation / on-tool extraction used; work in well-ventilated areas.",
        "Suitable RPE worn where extraction cannot control exposure at source.",
      ],
      sevWith: 3, likWith: 1,
    },
    hand_tools: {
      name: "Use of hand & power tools",
      persons: ["Operative", "Apprentice"],
      sevWithout: 3, likWithout: 3,
      controls: [
        "Correct tool selected for the task, inspected before use and used with guards in place; damaged tools removed from use.",
        "Operatives trained/competent; appropriate PPE (gloves, eye protection) worn.",
      ],
      sevWith: 3, likWith: 1,
    },
    power_tools: {
      name: "Cutting / abrasive tools",
      persons: ["Operative", "Apprentice"],
      sevWithout: 4, likWithout: 3,
      controls: [
        "Guards fitted and in place; correct disc/blade for the material, undamaged and within its use-by date; two hands on the tool.",
        "Eye/face protection, gloves and hearing protection worn; others kept clear and dust controlled.",
      ],
      sevWith: 4, likWith: 1,
    },
    refuelling: {
      name: "Refuelling of plant",
      persons: ["Operative", "Site Foreman", "Third Party"],
      sevWithout: 4, likWithout: 3,
      controls: [
        "Refuelling carried out with the engine off, away from ignition sources, using suitable containers and a drip tray / spill kit.",
        "Fuel stored securely in a bunded store away from excavations and drains; no smoking during refuelling.",
      ],
      sevWith: 4, likWith: 1,
    },
    adverse_weather: {
      name: "Adverse weather",
      persons: ["Operative", "Site Foreman", "Engineer"],
      sevWithout: 3, likWithout: 3,
      controls: [
        "Forecast monitored; high-level, lifting and hot works suspended in high winds/lightning; work adjusted for heat/cold.",
        "Appropriate clothing/PPE provided; excavations protected from flooding and re-inspected after heavy rain.",
      ],
      sevWith: 3, likWith: 1,
    },
    housekeeping: {
      name: "Poor housekeeping",
      persons: P_STD,
      sevWithout: 2, likWithout: 4,
      controls: [
        "Work areas kept tidy; waste cleared regularly to designated skips; access/egress and fire routes kept clear.",
      ],
      sevWith: 2, likWith: 1,
    },
    water_leak: {
      name: "Water / flooding (pipework)",
      persons: ["Operative", "Client"],
      sevWithout: 3, likWithout: 3,
      controls: [
        "Supply isolated and drained down before work; isolation valves identified; work area protected and leak-tested on completion.",
        "Absorbent materials / wet-vac available; adjacent electrical equipment protected.",
      ],
      sevWith: 3, likWith: 1,
    },
    hot_surfaces: {
      name: "Hot surfaces / scalding (heating systems)",
      persons: ["Operative", "Client"],
      sevWithout: 3, likWithout: 3,
      controls: [
        "System isolated and allowed to cool before work; heat-resistant gloves worn when handling hot components.",
        "Warning signage where hot surfaces remain; others kept clear.",
      ],
      sevWith: 3, likWith: 1,
    },
    gas_awareness: {
      name: "Gas awareness (working near gas)",
      persons: ["Operative", "Client", "Members of the public"],
      sevWithout: 5, likWithout: 2,
      controls: [
        "Gas work carried out only by Gas Safe registered engineers; others do not work on gas installations.",
        "If gas is smelled, the supply is isolated at the meter, ignition sources avoided, area ventilated and the emergency line called.",
      ],
      sevWith: 5, likWith: 1,
    },
    legionella: {
      name: "Legionella (water systems)",
      persons: ["Operative", "Client", "Members of the public"],
      sevWithout: 4, likWithout: 2,
      controls: [
        "Systems flushed and disinfected as required; dead legs avoided; temperatures maintained outside the 20-45°C growth range.",
        "Work planned to minimise aerosol generation; RPE worn where aerosols are likely.",
      ],
      sevWith: 4, likWith: 1,
    },
    pressure_test: {
      name: "Pressure testing / stored energy",
      persons: ["Operative", "Apprentice"],
      sevWithout: 4, likWithout: 3,
      controls: [
        "Test equipment rated for the pressure and in good order; system pressurised gradually and monitored; others kept clear during test.",
        "Pneumatic testing avoided where hydraulic testing is practicable; pressure released in a controlled manner before disconnection.",
      ],
      sevWith: 4, likWith: 1,
    },
  };

  // ── Selection tree: work type → sub-category → sub-type → hazard ids ────────
  const workTypes = [
    { id: "electrical", label: "Electrical", subs: [
      { id: "test", label: "Testing & inspection", types: [
        { id: "test_periodic", label: "Periodic inspection & testing (EICR)", hazards: ["electricity", "work_height_ladder", "manual_handling", "slips_trips"] },
        { id: "test_commission", label: "Commissioning / initial verification", hazards: ["electricity", "arc_flash", "slips_trips"] },
      ]},
      { id: "install", label: "Installation", types: [
        { id: "install_containment", label: "Containment & cabling", hazards: ["electricity", "work_height_mewp", "manual_handling", "power_tools", "dust", "slips_trips"] },
        { id: "install_accessories", label: "Accessories / second fix", hazards: ["electricity", "work_height_ladder", "hand_tools", "slips_trips"] },
        { id: "install_lighting", label: "Lighting / floodlighting", hazards: ["electricity", "work_height_mewp", "falling_objects", "asbestos", "manual_handling"] },
        { id: "install_db", label: "Distribution boards / supplies", hazards: ["electricity", "arc_flash", "manual_handling"] },
      ]},
      { id: "repair", label: "Repair & fault-finding", types: [
        { id: "repair_fault", label: "Fault-finding / repair", hazards: ["electricity", "work_height_ladder", "hand_tools"] },
        { id: "repair_live", label: "Live working (unavoidable)", hazards: ["electricity_live", "arc_flash"] },
      ]},
    ]},
    { id: "ground", label: "Groundworks & civils", subs: [
      { id: "excavation", label: "Excavation", types: [
        { id: "exc_trench", label: "Trenches & foundations", hazards: ["excavation_collapse", "underground_services", "plant_pedestrian", "manual_handling", "slips_trips"] },
        { id: "exc_deep", label: "Deep / battered dig", hazards: ["excavation_collapse", "underground_services", "confined_space", "plant_pedestrian"] },
      ]},
      { id: "concrete", label: "Concrete works", types: [
        { id: "conc_pour", label: "Shuttering & pouring", hazards: ["wet_concrete", "manual_handling", "plant_pedestrian", "noise_vibration"] },
      ]},
      { id: "drainage", label: "Drainage", types: [
        { id: "drain_runs", label: "Foul & surface water runs", hazards: ["excavation_collapse", "underground_services", "manual_handling", "biological_drainage", "confined_space"] },
      ]},
      { id: "plant", label: "Plant & lifting", types: [
        { id: "plant_op", label: "Plant operations", hazards: ["plant_pedestrian", "overturning", "refuelling", "noise_vibration"] },
        { id: "plant_lift", label: "Lifting operations", hazards: ["lifting_ops", "plant_pedestrian", "falling_objects"] },
      ]},
    ]},
    { id: "general", label: "General site / common", subs: [
      { id: "height", label: "Access & work at height", types: [
        { id: "h_mewp", label: "MEWP / cherry picker", hazards: ["work_height_mewp", "falling_objects", "plant_pedestrian"] },
        { id: "h_ladder", label: "Ladders & steps", hazards: ["work_height_ladder", "falling_objects"] },
        { id: "h_tower", label: "Mobile tower / scaffold", hazards: ["work_height_tower", "falling_objects"] },
        { id: "h_fragile", label: "Roof / fragile surfaces", hazards: ["fragile_surfaces", "falling_objects", "work_height_ladder"] },
      ]},
      { id: "handling", label: "Manual & material handling", types: [
        { id: "hand_manual", label: "Manual handling", hazards: ["manual_handling", "slips_trips"] },
        { id: "hand_lift", label: "Mechanical lifting", hazards: ["lifting_ops", "falling_objects"] },
      ]},
      { id: "health", label: "Health hazards", types: [
        { id: "he_dust", label: "Dust & silica", hazards: ["dust", "noise_vibration"] },
        { id: "he_coshh", label: "COSHH / substances", hazards: ["coshh"] },
        { id: "he_asbestos", label: "Asbestos (possible ACMs)", hazards: ["asbestos"] },
        { id: "he_noise", label: "Noise & vibration", hazards: ["noise_vibration"] },
      ]},
      { id: "env", label: "Site environment", types: [
        { id: "env_house", label: "Housekeeping & access", hazards: ["slips_trips", "housekeeping"] },
        { id: "env_weather", label: "Adverse weather", hazards: ["adverse_weather"] },
        { id: "env_fire", label: "Fire", hazards: ["fire_general"] },
      ]},
      { id: "hot", label: "Hot works", types: [
        { id: "hot_general", label: "Welding / grinding / cutting", hazards: ["hot_works", "fire_general", "fumes", "power_tools"] },
      ]},
    ]},
    { id: "mech", label: "Mechanical / plumbing", subs: [
      { id: "pipe", label: "Pipework & installation", types: [
        { id: "pipe_install", label: "Pipework installation", hazards: ["manual_handling", "hot_works", "work_height_ladder", "hand_tools", "water_leak"] },
        { id: "pipe_solder", label: "Soldering / brazing", hazards: ["hot_works", "fumes", "fire_general"] },
      ]},
      { id: "heating", label: "Heating & boilers", types: [
        { id: "heat_boiler", label: "Boiler / heating installation", hazards: ["hot_surfaces", "gas_awareness", "electricity", "legionella"] },
      ]},
      { id: "test_mech", label: "Testing & commissioning", types: [
        { id: "mech_pressure", label: "Pressure testing", hazards: ["pressure_test", "water_leak"] },
        { id: "mech_water", label: "Water systems / flushing", hazards: ["legionella", "water_leak", "biological_drainage"] },
      ]},
    ]},
  ];

  return { severityKey, likelihoodKey, riskControlPlan, band, hazards, workTypes };
})();
