// Mostlane RAMS hazard/control library + risk matrix.
// ---------------------------------------------------------------------------
// Powers the Risk Assessment Builder (hs-docs.html). Modelled on the THSP
// "Risk Assessment Builder": every hazard carries a WITHOUT-controls
// severity×likelihood and, after its control measures, a WITH-controls
// (residual) severity×likelihood. Risk rating = severity × likelihood.
//
// Each hazard also carries, THSP-style:
//   • controls tagged by the HSE Hierarchy of Control (Eliminate → Substitute →
//     Engineering → Administrative → PPE) so they order most-effective first;
//   • the PPE it calls for (aggregated into a Required-PPE list); and
//   • its likely injuries (aggregated into the assessment's Likely Harm(s)).
//
// STRUCTURE
//   HS_RAMS.severityKey / likelihoodKey / riskControlPlan / levels
//   HS_RAMS.hazards   — id → { name, persons[], injuries[], ppe[],
//                              sevWithout, likWithout, controls[{level,text}],
//                              sevWith, likWith }
//   HS_RAMS.workTypes — selection tree: work type → sub-category → sub-type,
//                       each sub-type listing the hazard ids it brings in.
//
// This is a shared starter library; an in-app editor and per-tenant overrides
// come next. Grow it by adding to `hazards` and referencing ids under the
// relevant sub-types.
window.HS_RAMS = (function () {
  const c = (level, text) => ({ level, text });   // control measure helper

  // HSE Hierarchy of Control — most effective first.
  const levels = [
    { id: "eliminate", label: "Elimination" },
    { id: "substitute", label: "Substitution" },
    { id: "engineering", label: "Engineering" },
    { id: "admin", label: "Administrative" },
    { id: "ppe", label: "PPE" },
  ];
  const levelRank = { eliminate: 0, substitute: 1, engineering: 2, admin: 3, ppe: 4 };

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

  function band(sev, lik) {
    const r = (Number(sev) || 0) * (Number(lik) || 0);
    if (r >= 15) return "High";
    if (r >= 8) return "Medium";
    return "Low";
  }

  const P_STD = ["Operative", "Supervisor", "Third Party", "Members of the public"];

  const hazards = {
    electricity: {
      name: "Contact with electricity",
      persons: ["Operative", "Apprentice", "Third Party"],
      injuries: ["Fatality", "Electric shock", "Burn injury", "Long term health effects"],
      ppe: ["Insulated gloves", "Safety boots", "Eye protection"],
      sevWithout: 5, likWithout: 5,
      controls: [
        c("engineering", "Circuits safely isolated, proved dead with a proprietary voltage indicator (proved on a known source before and after) and locked off with a personal lock and warning label before work begins."),
        c("admin", "Only suitably trained, competent and authorised persons carry out electrical work, working to BS 7671 and the Electricity at Work Regulations 1989."),
        c("admin", "All portable electrical tools and leads are inspected before use for damage; defective items are removed from use immediately, reported and quarantined."),
        c("ppe", "Insulated tools and appropriate PPE used; 110V or battery equipment used in preference to 230V."),
      ],
      sevWith: 5, likWith: 1,
    },
    electricity_live: {
      name: "Live electrical working",
      persons: ["Operative", "Apprentice"],
      injuries: ["Fatality", "Electric shock", "Burn injury"],
      ppe: ["Arc-rated gloves & clothing", "Face shield", "Insulated matting"],
      sevWithout: 5, likWithout: 5,
      controls: [
        c("eliminate", "Live working is avoided; work is only carried out live where it is unreasonable to work dead."),
        c("admin", "A documented live-working risk assessment / permit is in place and an accompanying person is present."),
        c("engineering", "Adjacent live parts are guarded or made dead; barriers and warning signage positioned."),
        c("ppe", "Competent person uses insulated tools, insulated matting and appropriate arc-rated PPE."),
      ],
      sevWith: 5, likWith: 2,
    },
    arc_flash: {
      name: "Arc flash / burns",
      persons: ["Operative", "Apprentice"],
      injuries: ["Burn injury", "Eye injury", "Fatality"],
      ppe: ["Arc-rated PPE", "Face shield"],
      sevWithout: 5, likWithout: 4,
      controls: [
        c("engineering", "Equipment is isolated and proved dead before work; working space, access and lighting are adequate."),
        c("admin", "Where live testing is unavoidable, minimum approach distances are maintained and tools are insulated and in good condition."),
        c("ppe", "Arc-rated face/hand protection and clothing worn."),
      ],
      sevWith: 5, likWith: 1,
    },
    work_height_mewp: {
      name: "Fall of person / object from height (MEWP)",
      persons: ["Operative", "Apprentice", "Third Party"],
      injuries: ["Fatality", "Fractures/broken bones", "Head injury"],
      ppe: ["Fall-arrest harness & lanyard", "Hard hat", "Safety boots"],
      sevWithout: 5, likWithout: 4,
      controls: [
        c("engineering", "Ground conditions assessed and outriggers used as required; exclusion zone established beneath the work area."),
        c("admin", "MEWP operated only by IPAF-certified operators; daily pre-use checks recorded and LOLER thorough examination in date; trained ground/rescue person present with a rescue plan."),
        c("ppe", "Harness and adjustable lanyard worn and clipped to the designated anchor in boom-type platforms."),
      ],
      sevWith: 5, likWith: 1,
    },
    work_height_ladder: {
      name: "Fall from height (ladders / steps)",
      persons: ["Operative", "Apprentice"],
      injuries: ["Fractures/broken bones", "Head injury", "Cut, abrasion, laceration or bruise"],
      ppe: ["Safety boots"],
      sevWithout: 4, likWithout: 4,
      controls: [
        c("substitute", "A suitable working platform (tower/MEWP) is used in preference where practicable."),
        c("admin", "Ladders used only for short-duration, low-risk work; inspected before use, sound, on firm level ground, secured/footed, at the correct angle with three points of contact maintained."),
      ],
      sevWith: 4, likWith: 1,
    },
    work_height_tower: {
      name: "Fall from height (mobile tower / scaffold)",
      persons: ["Operative", "Apprentice"],
      injuries: ["Fatality", "Fractures/broken bones", "Head injury"],
      ppe: ["Hard hat", "Safety boots"],
      sevWithout: 5, likWithout: 4,
      controls: [
        c("engineering", "Guardrails, toe-boards and outriggers fitted; wheels locked when in use."),
        c("admin", "Towers erected by PASMA-trained persons to manufacturer's instructions, inspected and tag-signed before use and after any alteration; not moved with persons/materials on board."),
      ],
      sevWith: 5, likWith: 1,
    },
    falling_objects: {
      name: "Strike by falling object",
      persons: P_STD,
      injuries: ["Head injury", "Fractures/broken bones", "Fatality"],
      ppe: ["Hard hat", "Safety boots"],
      sevWithout: 5, likWithout: 3,
      controls: [
        c("engineering", "Toe-boards, nets or brick guards fitted; materials raised/lowered by suitable means, never thrown."),
        c("admin", "Exclusion zones, barriers and signage established beneath overhead work; tools and materials secured/tethered and not left at height."),
        c("ppe", "Hard hats worn within the work area."),
      ],
      sevWith: 5, likWith: 1,
    },
    fragile_surfaces: {
      name: "Fall through fragile surface",
      persons: ["Operative", "Apprentice"],
      injuries: ["Fatality", "Fractures/broken bones"],
      ppe: ["Fall-arrest harness", "Hard hat"],
      sevWithout: 5, likWithout: 4,
      controls: [
        c("eliminate", "Work planned to avoid walking on fragile surfaces."),
        c("engineering", "Access prevented by covers, guardrails or staging boards; crawling boards and edge protection used where access is unavoidable."),
        c("admin", "Fragile surfaces (roof lights, old roof sheets) identified and clearly marked before work."),
      ],
      sevWith: 5, likWith: 1,
    },
    excavation_collapse: {
      name: "Excavation collapse / fall into excavation",
      persons: ["Operative", "Site Foreman", "Engineer"],
      injuries: ["Fatality", "Crush injury", "Asphyxiation"],
      ppe: ["Safety boots", "Hard hat", "Hi-vis"],
      sevWithout: 5, likWithout: 4,
      controls: [
        c("engineering", "Battering, stepping or trench support installed where depth/ground conditions require; edge protection / barriers and access ladders provided."),
        c("admin", "All excavations assessed daily by a competent person and the inspection recorded; no person enters an unsupported excavation over 1.2m deep; spoil, plant and materials kept back from the edge."),
      ],
      sevWith: 5, likWith: 1,
    },
    underground_services: {
      name: "Contact with underground services",
      persons: ["Operative", "Site Foreman", "Third Party"],
      injuries: ["Fatality", "Burn injury", "Electric shock"],
      ppe: ["Insulated gloves", "Safety boots"],
      sevWithout: 5, likWithout: 4,
      controls: [
        c("engineering", "Utility drawings obtained and a CAT & Genny survey completed before breaking ground; findings marked up on the surface."),
        c("admin", "Safe digging practices followed — hand-dig / vacuum excavation within 500mm of marked services; no mechanical excavation over known services."),
      ],
      sevWith: 5, likWith: 1,
    },
    plant_pedestrian: {
      name: "Plant / pedestrian interface",
      persons: P_STD.concat(["Site Foreman"]),
      injuries: ["Fatality", "Crush injury", "Fractures/broken bones"],
      ppe: ["Hi-vis", "Safety boots", "Hard hat"],
      sevWithout: 5, likWithout: 4,
      controls: [
        c("engineering", "Segregated pedestrian and plant routes established with barriers; plant fitted with working lights, beacons and reversing alarms."),
        c("admin", "Plant operated only by CPCS/NPORS-certified operators; banksman used for reversing/blind spots; exclusion zones around slewing plant."),
        c("ppe", "Hi-vis clothing worn by all on site."),
      ],
      sevWith: 5, likWith: 1,
    },
    overturning: {
      name: "Plant overturn",
      persons: ["Operative", "Site Foreman"],
      injuries: ["Fatality", "Crush injury"],
      ppe: ["Seatbelt (in cab)", "Hi-vis"],
      sevWithout: 5, likWithout: 3,
      controls: [
        c("engineering", "ROPS/FOPS fitted and seatbelts in use; plant operated on stable, level ground with outriggers where fitted."),
        c("admin", "Ground assessed for bearing capacity; plant operated within its rated capacity; loads kept low when travelling."),
      ],
      sevWith: 5, likWith: 1,
    },
    lifting_ops: {
      name: "Lifting operations",
      persons: ["Operative", "Site Foreman", "Third Party"],
      injuries: ["Fatality", "Crush injury", "Fractures/broken bones"],
      ppe: ["Hard hat", "Safety boots", "Gloves"],
      sevWithout: 5, likWithout: 3,
      controls: [
        c("engineering", "Certified lifting accessories (LOLER, in date) inspected before use; exclusion zone under the load."),
        c("admin", "Lift planned by a competent Appointed Person; trained slinger/signaller directs the lift; no person passes/stands beneath a suspended load."),
      ],
      sevWith: 5, likWith: 1,
    },
    wet_concrete: {
      name: "Wet concrete (burns / dermatitis)",
      persons: ["Operative", "Site Foreman"],
      injuries: ["Burn injury", "Dermatitis", "Eye injury"],
      ppe: ["Waterproof gloves", "Waterproof trousers/boots", "Eye protection"],
      sevWithout: 3, likWithout: 3,
      controls: [
        c("admin", "Skin contact avoided and washed off promptly; welfare/washing facilities, barrier cream and eye-wash provided."),
        c("ppe", "Impervious gloves, waterproof trousers/boots and eye protection worn."),
      ],
      sevWith: 3, likWith: 1,
    },
    manual_handling: {
      name: "Manual handling",
      persons: ["Operative", "Apprentice"],
      injuries: ["Musculoskeletal injury", "Short term health effects", "Cut, abrasion, laceration or bruise"],
      ppe: ["Gloves", "Safety boots"],
      sevWithout: 3, likWithout: 4,
      controls: [
        c("engineering", "Mechanical aids (trolleys, teleporter, genie) used in preference to manual lifting."),
        c("admin", "Loads assessed and split where possible; team lifts used for awkward/heavy items; operatives trained in safe manual-handling technique."),
      ],
      sevWith: 3, likWith: 1,
    },
    slips_trips: {
      name: "Slips, trips and falls",
      persons: P_STD,
      injuries: ["Fractures/broken bones", "Cut, abrasion, laceration or bruise"],
      ppe: ["Safety boots"],
      sevWithout: 3, likWithout: 4,
      controls: [
        c("engineering", "Leads/hoses routed off walkways or covered; adequate lighting provided."),
        c("admin", "Good housekeeping maintained; work areas kept clear of offcuts and materials; spillages cleaned immediately."),
      ],
      sevWith: 3, likWith: 1,
    },
    noise_vibration: {
      name: "Noise and vibration",
      persons: ["Operative", "Site Foreman"],
      injuries: ["Hearing loss", "Hand-arm vibration syndrome (HAVS)"],
      ppe: ["Hearing protection", "Anti-vibration gloves"],
      sevWithout: 3, likWithout: 3,
      controls: [
        c("substitute", "Low-vibration/low-noise tools selected."),
        c("admin", "Trigger/exposure times managed and job rotation used to stay within EAV/ELV limits."),
        c("ppe", "Hearing protection worn in designated zones; anti-vibration gloves provided where appropriate."),
      ],
      sevWith: 3, likWith: 1,
    },
    dust: {
      name: "Exposure to dust (incl. silica)",
      persons: ["Operative", "Apprentice", "Third Party"],
      injuries: ["Respiratory illness", "Long term health effects", "Eye injury"],
      ppe: ["RPE (FFP3, face-fit tested)", "Eye protection"],
      sevWithout: 4, likWithout: 4,
      controls: [
        c("engineering", "Dust suppressed at source using water or on-tool extraction (M/H-class); dry cutting avoided."),
        c("admin", "Area ventilated and others kept clear; exposure times managed."),
        c("ppe", "Suitable RPE (FFP3, face-fit tested) and eye protection worn."),
      ],
      sevWith: 4, likWith: 1,
    },
    coshh: {
      name: "Hazardous substances (COSHH)",
      persons: ["Operative", "Apprentice"],
      injuries: ["Dermatitis", "Respiratory illness", "Burn injury"],
      ppe: ["Gloves (per SDS)", "RPE", "Eye protection"],
      sevWithout: 3, likWithout: 3,
      controls: [
        c("substitute", "Least-hazardous product selected; COSHH assessment completed for each substance with safety data sheets held on site."),
        c("admin", "Substances stored, used and disposed of per the SDS; spill kit available."),
        c("ppe", "Correct PPE (gloves/RPE/eye protection) worn."),
      ],
      sevWith: 3, likWith: 1,
    },
    asbestos: {
      name: "Exposure to asbestos",
      persons: ["Operative", "Apprentice", "Third Party", "Members of the public"],
      injuries: ["Long term health effects", "Respiratory illness", "Fatality"],
      ppe: ["Disposable coveralls", "RPE (FFP3)"],
      sevWithout: 4, likWithout: 5,
      controls: [
        c("eliminate", "Work planned to avoid disturbing ACMs; if suspected material is found, work stops immediately and is reported — licensed removal arranged where required."),
        c("admin", "Asbestos identified via the client's asbestos register / refurbishment & demolition survey before work; ACMs clearly marked."),
      ],
      sevWith: 4, likWith: 1,
    },
    biological_drainage: {
      name: "Biological hazard (drainage / foul water)",
      persons: ["Operative", "Site Foreman"],
      injuries: ["Short term health effects", "Long term health effects"],
      ppe: ["Impervious gloves", "Eye protection"],
      sevWithout: 3, likWithout: 3,
      controls: [
        c("admin", "Cuts covered; hands washed before eating; no eating/drinking/smoking in the work area; welfare facilities used; vaccination status (e.g. tetanus) considered."),
        c("ppe", "Impervious gloves and eye protection worn."),
      ],
      sevWith: 3, likWith: 1,
    },
    confined_space: {
      name: "Confined space",
      persons: ["Operative", "Site Foreman"],
      injuries: ["Fatality", "Asphyxiation", "Long term health effects"],
      ppe: ["Gas monitor", "Rescue harness", "RPE"],
      sevWithout: 5, likWithout: 4,
      controls: [
        c("eliminate", "Confined-space entry avoided where possible."),
        c("engineering", "Forced ventilation and continuous gas monitoring provided; communications maintained."),
        c("admin", "Where unavoidable, a permit-to-work, atmosphere testing and a trained top-man with rescue plan/equipment are in place; only trained, competent persons enter."),
      ],
      sevWith: 5, likWith: 1,
    },
    hot_works: {
      name: "Hot works (fire)",
      persons: P_STD,
      injuries: ["Burn injury", "Fatality", "Respiratory illness"],
      ppe: ["Flame-resistant gloves", "Face shield/goggles"],
      sevWithout: 5, likWithout: 3,
      controls: [
        c("admin", "A Hot Works Permit is raised; combustibles removed/protected within 10m; a fire watch is maintained during the works and for at least 60 minutes afterwards, and the area re-inspected before leaving."),
        c("engineering", "A suitable fire extinguisher is to hand; gas cylinders secured with flashback arrestors fitted."),
      ],
      sevWith: 5, likWith: 1,
    },
    fire_general: {
      name: "Fire",
      persons: P_STD,
      injuries: ["Burn injury", "Respiratory illness", "Fatality"],
      ppe: [],
      sevWithout: 4, likWithout: 3,
      controls: [
        c("engineering", "Suitable extinguishers available; ignition sources controlled."),
        c("admin", "Good housekeeping; flammable materials stored safely and quantities on site minimised; site fire/emergency arrangements briefed to all."),
      ],
      sevWith: 4, likWith: 1,
    },
    fumes: {
      name: "Welding / soldering fumes",
      persons: ["Operative", "Apprentice"],
      injuries: ["Respiratory illness", "Long term health effects"],
      ppe: ["RPE", "Eye protection"],
      sevWithout: 3, likWithout: 3,
      controls: [
        c("engineering", "Local exhaust ventilation / on-tool extraction used; work in well-ventilated areas."),
        c("ppe", "Suitable RPE worn where extraction cannot control exposure at source."),
      ],
      sevWith: 3, likWith: 1,
    },
    hand_tools: {
      name: "Use of hand & power tools",
      persons: ["Operative", "Apprentice"],
      injuries: ["Cut, abrasion, laceration or bruise", "Eye injury"],
      ppe: ["Gloves", "Eye protection"],
      sevWithout: 3, likWithout: 3,
      controls: [
        c("admin", "Correct tool selected for the task, inspected before use and used with guards in place; damaged tools removed from use; operatives trained/competent."),
        c("ppe", "Appropriate PPE (gloves, eye protection) worn."),
      ],
      sevWith: 3, likWith: 1,
    },
    power_tools: {
      name: "Cutting / abrasive tools",
      persons: ["Operative", "Apprentice"],
      injuries: ["Cut, abrasion, laceration or bruise", "Eye injury", "Hearing loss"],
      ppe: ["Face/eye protection", "Cut-resistant gloves", "Hearing protection"],
      sevWithout: 4, likWithout: 3,
      controls: [
        c("engineering", "Guards fitted and in place; correct disc/blade for the material, undamaged and within its use-by date; dust controlled."),
        c("admin", "Two hands on the tool; others kept clear."),
        c("ppe", "Eye/face protection, gloves and hearing protection worn."),
      ],
      sevWith: 4, likWith: 1,
    },
    refuelling: {
      name: "Refuelling of plant",
      persons: ["Operative", "Site Foreman", "Third Party"],
      injuries: ["Burn injury", "Dermatitis", "Fire"],
      ppe: ["Gloves", "Eye protection"],
      sevWithout: 4, likWithout: 3,
      controls: [
        c("engineering", "Fuel stored securely in a bunded store away from excavations and drains; drip tray / spill kit used."),
        c("admin", "Refuelling carried out with the engine off, away from ignition sources, using suitable containers; no smoking during refuelling."),
      ],
      sevWith: 4, likWith: 1,
    },
    adverse_weather: {
      name: "Adverse weather",
      persons: ["Operative", "Site Foreman", "Engineer"],
      injuries: ["Short term health effects", "Slips/fractures"],
      ppe: ["Weatherproof clothing"],
      sevWithout: 3, likWithout: 3,
      controls: [
        c("admin", "Forecast monitored; high-level, lifting and hot works suspended in high winds/lightning; work adjusted for heat/cold; excavations protected from flooding and re-inspected after heavy rain."),
        c("ppe", "Appropriate weatherproof clothing/PPE provided."),
      ],
      sevWith: 3, likWith: 1,
    },
    housekeeping: {
      name: "Poor housekeeping",
      persons: P_STD,
      injuries: ["Cut, abrasion, laceration or bruise", "Slips/trips"],
      ppe: ["Safety boots"],
      sevWithout: 2, likWithout: 4,
      controls: [
        c("admin", "Work areas kept tidy; waste cleared regularly to designated skips; access/egress and fire routes kept clear."),
      ],
      sevWith: 2, likWith: 1,
    },
    water_leak: {
      name: "Water / flooding (pipework)",
      persons: ["Operative", "Client"],
      injuries: ["Electric shock", "Slips/trips", "Property damage"],
      ppe: ["Gloves"],
      sevWithout: 3, likWithout: 3,
      controls: [
        c("engineering", "Supply isolated and drained down before work; isolation valves identified; adjacent electrical equipment protected."),
        c("admin", "Work area protected and leak-tested on completion; absorbent materials / wet-vac available."),
      ],
      sevWith: 3, likWith: 1,
    },
    hot_surfaces: {
      name: "Hot surfaces / scalding (heating systems)",
      persons: ["Operative", "Client"],
      injuries: ["Burn injury"],
      ppe: ["Heat-resistant gloves"],
      sevWithout: 3, likWithout: 3,
      controls: [
        c("admin", "System isolated and allowed to cool before work; warning signage where hot surfaces remain; others kept clear."),
        c("ppe", "Heat-resistant gloves worn when handling hot components."),
      ],
      sevWith: 3, likWith: 1,
    },
    gas_awareness: {
      name: "Gas awareness (working near gas)",
      persons: ["Operative", "Client", "Members of the public"],
      injuries: ["Fatality", "Burn injury", "Asphyxiation"],
      ppe: [],
      sevWithout: 5, likWithout: 2,
      controls: [
        c("eliminate", "Others do not work on gas installations — gas work carried out only by Gas Safe registered engineers."),
        c("admin", "If gas is smelled, the supply is isolated at the meter, ignition sources avoided, area ventilated and the emergency line called."),
      ],
      sevWith: 5, likWith: 1,
    },
    legionella: {
      name: "Legionella (water systems)",
      persons: ["Operative", "Client", "Members of the public"],
      injuries: ["Respiratory illness", "Long term health effects", "Fatality"],
      ppe: ["RPE"],
      sevWithout: 4, likWithout: 2,
      controls: [
        c("engineering", "Dead legs avoided; temperatures maintained outside the 20-45°C growth range."),
        c("admin", "Systems flushed and disinfected as required; work planned to minimise aerosol generation."),
        c("ppe", "RPE worn where aerosols are likely."),
      ],
      sevWith: 4, likWith: 1,
    },
    pressure_test: {
      name: "Pressure testing / stored energy",
      persons: ["Operative", "Apprentice"],
      injuries: ["Fractures/broken bones", "Eye injury", "Cut, abrasion, laceration or bruise"],
      ppe: ["Eye protection", "Gloves"],
      sevWithout: 4, likWithout: 3,
      controls: [
        c("substitute", "Pneumatic testing avoided where hydraulic testing is practicable."),
        c("engineering", "Test equipment rated for the pressure and in good order; system pressurised gradually and monitored; pressure released in a controlled manner before disconnection."),
        c("admin", "Others kept clear during test."),
      ],
      sevWith: 4, likWith: 1,
    },
  };

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

  return { severityKey, likelihoodKey, riskControlPlan, levels, levelRank, band, hazards, workTypes };
})();
