/* ============================================================================
   Mostlane Employment Contract — shared model  (window.MLContract)
   ----------------------------------------------------------------------------
   The clause wording, numbering, cross-references and conditional logic are
   ported VERBATIM from the reviewed reference builder. Do NOT reword, add or
   remove clauses here — the text is deliberate and legally reviewed.

   ONE source feeds two outputs so they match word for word:
     • MLContract.markup(state)        -> portal signed-document body markup
                                          (# / ## / - / | tables | / **bold**),
                                          with NO signature tables — the portal
                                          signing block handles signing: the
                                          Company signatory is the logged-in
                                          Full-Access issuer, the employee signs
                                          on the sign page. Signing is entirely
                                          in-portal — there is no Word/file copy.
     • MLContract.previewHtml(state)   -> the live on-screen preview (same markup
                                          rendered to HTML; missing fields shown
                                          as [Placeholders]).
   ============================================================================ */
(function () {
  "use strict";

  // ── Minimum wage: ONE labelled constant. UPDATE EVERY APRIL. ───────────────
  // (National Living/Minimum Wage, England & Wales.)
  var MIN_WAGE = { from: "1 April 2026", adult: 12.71, age18: 10.85, apprentice: 8.00 };

  var DEFAULTS = {
    employeeName: "", employeeAddress: "", startDate: "",
    jobTitle: "", hourlyRate: "",
    duties: "general electrical works, testing and inspection, emergency lighting testing, portable appliance testing, general reactive maintenance and general building works",
    workStart: "8.00am", workEnd: "4.30pm", workDays: "Monday to Friday", lunchMins: "30",
    employeeNotice: "4", holidayDays: "28",
    travelUnpaid: true, travelMins: "30",
    overtimeEnhanced: true, overtimeRate: "1.5", overtimeAfter: "10",
    probation: true, probationMonths: "6",
    apprentice: false, apprenticeshipStandard: "", trainingProvider: "",
    van: true, optOut: true, trainingRepay: false,
    // Which documents to send (the "Employee Documents" picker). Shared details
    // from the contract pre-fill them; each goes out as its own signing request.
    sendContract: true, sendVan: false, sendPpe: false,
    // issuer = the logged-in sender (auto). issueDate = the date on the PPE
    // record, set by the user and defaulting to the start date.
    issuerName: "", issueDate: ""
  };
  var LABELS = {
    employeeName: "Employee name", employeeAddress: "Employee address", startDate: "Start date",
    issueDate: "Issue date",
    jobTitle: "Job title", hourlyRate: "Hourly rate", duties: "Duties",
    workStart: "Start time", workEnd: "Finish time", workDays: "Working days", lunchMins: "Lunch minutes",
    employeeNotice: "Weeks", holidayDays: "Holiday days", travelMins: "Minutes",
    overtimeRate: "Multiplier", overtimeAfter: "Hours", probationMonths: "Months",
    apprenticeshipStandard: "Apprenticeship", trainingProvider: "Training provider"
  };

  var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  function fmtDate(v) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); return m ? ((+m[3]) + " " + MONTHS[+m[2] - 1] + " " + m[1]) : v; }
  function val(state, k) {
    var v = state[k];
    if (v === "" || v == null) return null;
    if (k === "startDate" || k === "issueDate") return fmtDate(v);
    if (k === "hourlyRate") { var n = Number(v); return isNaN(n) ? String(v) : n.toFixed(2); }
    if (k === "employeeAddress") return String(v).split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean).join(", ");
    return String(v).trim();
  }
  function ok(state, w) { if (!w) return true; return w[0] === "!" ? !state[w.slice(1)] : !!state[w]; }

  /* ---------- Contract content (VERBATIM) ---------- */
  var INTRO = [
    "This contract of employment is made between **Mostlane Construction Limited** of Segensworth Business Centre, Fareham, PO15 5RQ (‘the Company’) and **{employeeName}** of {employeeAddress} (‘you’). It meets the requirements of section 1 of the Employment Rights Act 1996 (as amended).",
    "This contract supersedes any earlier written or oral arrangement between you and the Company.",
    "The headings in this contract are for convenience only and do not affect its interpretation."
  ];

  var SECTIONS = [
    { id: "job", title: "Job title and place of work", items: [
      { p: "The Company will employ you in the role of **{jobTitle}**. Your duties and responsibilities include {duties}. The Company may vary your duties and responsibilities from time to time according to the needs of the business, provided they remain reasonable and suited to your skills and experience." },
      { p: "You do not have a single fixed place of work. You will work at client sites across the UK, generally in the south of England, as current workload requires. Your administrative base is the Company’s office at Segensworth Business Centre, Fareham, PO15 5RQ." },
      { p: "You are employed as an apprentice under an approved apprenticeship. Your apprenticeship is **{apprenticeshipStandard}**, delivered with {trainingProvider}. The Company will give you time during your paid working hours for off-the-job training and assessment. Your apprenticeship agreement and commitment statement form part of this contract.", when: "apprentice" },
      { p: "When you complete your apprenticeship, your employment will continue on the terms of this contract unless the Company confirms otherwise in writing. Your job title and rate of pay will be reviewed at that point.", when: "apprentice" }
    ]},
    { id: "start", title: "Start of employment", items: [
      { p: "Your employment with the Company starts on **{startDate}**. No period of employment with a previous employer counts towards your period of continuous employment." },
      { p: "Your employment is not for a fixed term and there is no anticipated duration. It will continue until ended by either party in accordance with clause {#notice}." }
    ]},
    { id: "probation", title: "Probationary period", when: "probation", items: [
      { p: "The first {probationMonths} months of your employment will be a probationary period, during which your performance and conduct will be monitored and reviewed. The Company may extend the probationary period once, by up to three months, by telling you in writing before it ends." },
      { p: "The Company may end your employment at any time during, or at the end of, your probationary period if it finds you are not suitable for the role, by giving you the notice set out in clause {#noticeTable}." },
      { p: "At the end of your probationary period your performance will be reviewed and the Company will confirm the outcome to you in writing. If the Company has not written to you within one month of the end of the probationary period, you will be treated as having passed it." }
    ]},
    { id: "notice", title: "Notice", items: [
      { p: "Your employment may be ended by either party giving written notice as follows:", id: "noticeTable" },
      { table: { head: ["Your continuous service", "Notice you must give", "Notice the Company must give"], rows: [
        { cells: ["Less than one month", "None", "None"] },
        { cells: ["One month, until you pass your probationary period", "One week", "One week"], when: "probation" },
        { cells: ["After your probationary period, until two years", "{employeeNotice} weeks", "One week"], when: "probation" },
        { cells: ["One month to two years", "{employeeNotice} weeks", "One week"], when: "!probation" },
        { cells: ["Two years to twelve years", "{employeeNotice} weeks", "One week for each complete year of service"] },
        { cells: ["Twelve years or more", "{employeeNotice} weeks", "Twelve weeks"] }
      ]}},
      { p: "The notice given by the Company will never be less than the statutory minimum under section 86 of the Employment Rights Act 1996." },
      { p: "Nothing in this contract prevents the Company from ending your employment without notice, or payment in lieu of notice, in a case of gross misconduct." },
      { p: "**Payment in lieu of notice.** The Company is not obliged to provide you with work at any time after notice has been given by either party. The Company may, in its absolute discretion, pay you in lieu of all or any part of the unexpired notice period, subject to deduction of income tax and National Insurance contributions. Any such payment will consist solely of basic pay at the date of termination. For the avoidance of doubt, it will not include any bonus or commission that might otherwise have been due, any payment in respect of benefits, or any payment in respect of holiday that would have accrued during the period for which the payment in lieu is made. You have no right to a payment in lieu of notice unless the Company chooses to make one under this clause." },
      { p: "**Garden leave.** The Company may, in its absolute discretion, place you on garden leave for all or any part of your notice period. While on garden leave you remain bound by all the terms of this contract but must not attend any Company or client premises or contact the Company’s clients, unless the Company asks you to. You must remain available for work during your normal working hours should the Company need you. During garden leave you must not work for any other employer or in any self-employed capacity until your employment has ended. You will be paid your normal pay and benefits up to the date your employment ends." },
      { p: "**Leaving without notice.** If you leave without giving the notice required by clause {#noticeTable}, or leave during your notice period without permission:" },
      { sub: [
        "you will not be paid for any period of notice that you do not work; and",
        "the Company may deduct from your final pay the actual loss it suffers as a result of your leaving without notice (for example, the extra cost of covering your work or recruiting a replacement at short notice), up to a maximum of one day’s basic pay for each working day of notice not worked."
      ]},
      { cont: "Any such deduction is a genuine attempt by the Company to assess its loss and is not intended as a penalty." }
    ]},
    { id: "hours", title: "Hours of work, overtime and travel", items: [
      { p: "Your normal hours of work are {workStart} to {workEnd}, {workDays}, with an unpaid lunch break of {lunchMins} minutes. These are your normal hours unless otherwise agreed between you and the Company." },
      { p: "You may be required to work additional hours beyond your normal hours where they are reasonably necessary for the proper performance of your duties and to meet the needs of the business." },
      { p: "The Company may require you to work different hours according to the needs of the business, on a temporary or permanent basis. This may involve shorter or longer hours, different days of the week, or different times of day, in line with operational requirements. You will be given as much notice of any change as is reasonably practicable." },
      { p: "**Overtime.** Only overtime worked at the request of, or with the prior approval of, a director or your line manager will be paid. Approved overtime is paid at your basic hourly rate, except that any hours worked beyond {overtimeAfter} hours in a single day are paid at {overtimeRate} times your basic hourly rate.", when: "overtimeEnhanced" },
      { p: "**Overtime.** Only overtime worked at the request of, or with the prior approval of, a director or your line manager will be paid. Approved overtime is paid at your basic hourly rate. No enhanced overtime rate applies.", when: "!overtimeEnhanced" },
      { p: "**Travel time.** The first {travelMins} minutes of travel at the start of each working day, from your home to your first site, and the first {travelMins} minutes of travel at the end of each working day, from your last site to your home, are unpaid. Where either journey takes less than {travelMins} minutes, the whole of that journey is unpaid. Any travel beyond the first {travelMins} minutes of either journey is paid at your basic hourly rate.", when: "travelUnpaid" },
      { sub: [
        "Travel between sites during the working day, and travel to collect materials or equipment at the Company’s request, is working time and is paid at your basic hourly rate.",
        "Travel time is recorded from your timesheets and, where a Company vehicle is used, its telematics.",
        "Unpaid travel under this clause will never reduce your average pay below the National Minimum Wage for any pay reference period."
      ], when: "travelUnpaid" },
      { p: "**Travel time.** All travel time between your home and site, between sites during the working day, and to collect materials or equipment at the Company’s request, is paid at your basic hourly rate.", when: "!travelUnpaid" },
      { p: "**Working time.** The Working Time Regulations 1998 limit your average weekly working time to 48 hours unless you agree otherwise. You may choose to sign a separate agreement opting out of this limit. Signing it is voluntary, you will not be treated less favourably if you choose not to, and you may withdraw it at any time by giving the Company seven days’ written notice.", when: "optOut" }
    ]},
    { id: "pay", title: "Pay and benefits", items: [
      { p: "Your pay will be **£{hourlyRate} per hour**, paid weekly in arrears on or before the last working day of each week for the week up to and including that day. Payment will be made by direct credit transfer to a bank or building society account nominated by you." },
      { p: "Your pay will be reviewed annually at the Company’s discretion. A review will not necessarily result in an increase. There will be no review of your pay after notice has been given by either party. Your rate of pay will never be less than the National Minimum Wage or National Living Wage that applies to you." },
      { p: "You will be reimbursed all reasonable expenses properly, wholly and exclusively incurred by you in carrying out your duties, provided they have been authorised by your line manager and you produce receipts or other evidence the Company reasonably requires." },
      { p: "**Company vehicle.** A company van will be provided for your use, in line with the Company’s van agreement policy. You must hold a full, valid UK driving licence and tell the Company immediately of any penalty points, disqualification, or medical condition that affects your ability to drive. You agree that the Company may check your driving licence record with the DVLA.", when: "van" },
      { p: "**Deductions.** By signing this contract you agree that the Company may deduct the following from your pay, including from any final payment of pay:", id: "deductions" },
      { sub: [
        { t: "any overpayment of wages or expenses;" },
        { t: "any loan or advance made to you by the Company;" },
        { t: "parking, speeding, congestion, toll or other fines and penalty charges incurred while you were driving a Company vehicle, together with any reasonable administration charge made by the issuing body or the vehicle’s lease company;", when: "van" },
        { t: "the reasonable cost of repairing or replacing Company property that is lost or damaged through your negligence or deliberate act, or that you fail to return when your employment ends;" },
        { t: "the value of any holiday taken but not earned when your employment ends, under clause {#overtaken}; and" },
        { t: "any other sum you owe the Company when your employment ends." }
      ]},
      { cont: "The Company will discuss any deduction for fines, damage or unreturned property with you before making it. No deduction will reduce your pay below the National Minimum Wage for any pay reference period, except for the recovery of an overpayment of wages or expenses." }
    ]},
    { id: "review", title: "Review of performance", items: [
      { p: "Your performance will be reviewed at least once in each year. The timing of the review is at the Company’s discretion. You will be given details of any review procedure and you must take part in it." },
      { p: "Your performance will also be reviewed, separately from the annual review, during and at the end of your probationary period.", when: "probation" }
    ]},
    { id: "holiday", title: "Holiday", items: [
      { p: "The Company’s holiday year runs from 1 January to 31 December. You are entitled to {holidayDays} days’ paid holiday in each holiday year, inclusive of the usual public holidays in England and Wales. Under the Working Time Regulations 1998 this includes your statutory basic leave of four weeks and statutory additional leave of 1.6 weeks. Holiday taken is deducted first from your statutory basic leave and then from your remaining entitlement." },
      { p: "**Holiday pay.** For your four weeks of statutory basic leave you will be paid your normal remuneration, including any overtime you work regularly, based on your average pay over the previous 52 weeks in which you were paid. For the rest of your entitlement you will be paid at your basic hourly rate for your normal hours." },
      { p: "**Booking holiday.** You must follow the Company’s system for getting approval before booking holiday. You must give at least 30 days’ notice of the start date of any holiday, and you must not book a holiday until your request has been authorised in writing by your line manager. The Company will try to accommodate your holiday plans where possible, subject to the needs of the business. No more than two weeks’ holiday may be taken at one time without the prior written agreement of a director." },
      { p: "The Company may require you to take holiday on particular days, including the period between Christmas and New Year, by giving you notice in line with the Working Time Regulations 1998." },
      { p: "**Carrying holiday over.** You must use your holiday entitlement by 31 December each year. Holiday not taken by that date is lost and will not be paid, except where the law requires it to be carried over. That includes holiday you could not take because of sickness or maternity, paternity, adoption, shared parental or other family-related leave, or because the Company did not give you a reasonable opportunity to take it." },
      { p: "In your first and last holiday year of employment, your entitlement is calculated pro rata to the part of the holiday year in which you are employed, to the nearest half day, on the basis that holiday accrues evenly from day to day." },
      { p: "When your employment ends, you will be paid in lieu of any holiday accrued but not taken in that holiday year, together with any holiday carried over under clause {#carry}. The Company may require you to take any outstanding holiday during your notice period, whichever party gave notice." },
      { p: "If, when your employment ends, you have taken more holiday than you have accrued in that holiday year, you must repay the Company for the unearned holiday, and the Company may deduct its value from your final pay.", id: "overtaken" },
      { p: "If you are sick during a period of booked holiday and report it in line with clause {#sickness}, those days may be treated as sickness absence rather than holiday, at your request, and you may re-book the holiday later in the holiday year." }
    ]},
    { id: "compassionate", title: "Compassionate leave and time off for family emergencies", items: [
      { p: "You have the statutory right to reasonable unpaid time off to deal with an emergency involving a dependant. The Company will also consider any request for compassionate leave. If you need time off, raise it with a director as soon as possible. There is no contractual right to pay for this time off; any payment is at the Company’s discretion." },
      { p: "Apart from holiday and the statutory leave set out in this contract, there is no other paid leave." }
    ]},
    { id: "parental", title: "Family leave and pay", items: [
      { p: "You are entitled to maternity, paternity, adoption, shared parental, parental bereavement and neonatal care leave and pay, and to unpaid parental leave, where you meet the statutory eligibility conditions. There is no enhanced contractual pay for these types of leave." }
    ]},
    { id: "sickpay", title: "Sick pay", items: [
      { p: "You are entitled to Statutory Sick Pay (SSP) during periods of sickness absence, in line with the legislation in force at the time. Any payment above SSP is at the Company’s absolute discretion." }
    ]},
    { id: "sickness", title: "Reporting sickness absence", items: [
      { p: "On the first day of any sickness absence you must telephone a director at the earliest possible opportunity, and in any event before your normal start time. A text message or email is not enough. You must give the nature of your illness and the day you expect to return to work, and tell the Company as soon as possible of any change to that date." },
      { p: "Sickness absence of up to seven consecutive calendar days must be covered by a self-certificate. Any absence longer than that must be covered by one or more fit notes from a doctor or other authorised healthcare professional, provided to the Company regularly throughout the absence." },
      { p: "You must tell a director on your first day back at work after sickness absence and complete a self-certificate where required. Self-certificate forms are available from the office." }
    ]},
    { id: "medical", title: "Medical examinations", items: [
      { p: "Where it is reasonable to do so, the Company may ask you to undergo a medical examination by a medical practitioner it nominates, at any stage of your employment. Where you consent, you also agree that the practitioner may prepare a report on the results and disclose it to the Company. The Company will pay for any such examination and will handle the information in line with data protection law." },
      { p: "The Company may also ask for a medical report from your GP or consultant. If it does, you will be told of your rights under the Access to Medical Reports Act 1988 and asked for your written consent before the Company contacts them." }
    ]},
    { id: "pension", title: "Pension", items: [
      { p: "The Company uses the National Employment Savings Trust (NEST) for pension provision. In line with its duties under the Pensions Act 2008, the Company will enrol you as an active member of NEST, or any other registered pension scheme that replaces it, if you are eligible. You will be subject to the scheme rules in force from time to time and HM Revenue & Customs requirements. Full details of the scheme will be sent to you." },
      { p: "If, because of your age or earnings, you are not eligible for automatic enrolment, you will be told of any right to opt in to the scheme and given full details if you do." },
      { p: "You will pay at least the minimum contributions set by legislation, and the Company will pay at least its minimum contributions. Your contributions will be deducted from your pay and paid into the scheme." }
    ]},
    { id: "retirement", title: "Retirement", items: [
      { p: "The Company does not operate a normal retirement age, and you will not be compulsorily retired on reaching any particular age. You may choose to retire at any time by giving the notice set out in clause {#noticeTable}." }
    ]},
    { id: "collective", title: "Collective agreements and periods outside the UK", items: [
      { p: "There are no collective agreements that directly affect the terms of your employment." },
      { p: "You will not be required to work outside the United Kingdom for one month or more." }
    ]},
    { id: "disciplinary", title: "Disciplinary rules", items: [
      { p: "The Company’s disciplinary rules and procedure are set out in the Staff Handbook, a copy of which is given to you with this contract. They do not form part of your contract, and the Company may change them from time to time. If you are dissatisfied with any disciplinary decision, you may appeal in writing to a director as set out in the procedure." }
    ]},
    { id: "grievance", title: "Grievance procedure", items: [
      { p: "If you have a grievance about your employment, you should raise it in writing with a director. The Company’s grievance procedure is set out in the Staff Handbook. It does not form part of your contract." }
    ]},
    { id: "equal", title: "Equal opportunities", items: [
      { p: "It is the Company’s policy to provide employment, training, promotion, transfer, pay, benefits and other terms and conditions of employment without regard to age, disability, gender reassignment, marriage and civil partnership, pregnancy and maternity, race (including colour, nationality and ethnic or national origins), religion or belief, sex or sexual orientation. It is also the Company’s policy to meet all employment standards required by law." }
    ]},
    { id: "layoff", title: "Lay-offs and short-time working", items: [
      { p: "The Company may lay you off or put you on short-time working where the needs of the business make this necessary, for example because of a temporary stop in, or reduction of, work, or a temporary closure of the workplace." },
      { p: "If you are laid off or put on short-time working, your right to pay for workless days in that period will stop. Instead, if you qualify, you will be paid statutory guarantee payments at the rate in force at the time." }
    ]},
    { id: "restrictions", title: "Restrictions", items: [
      { p: "During your normal hours of work you may not, without the Company’s prior written consent, spend any time on any business other than the Company’s, or on any public or charitable duty." },
      { p: "During your employment you may not, without the Company’s prior written consent, carry out any work or other activity that may harm your ability to perform your duties properly and efficiently. The decision as to whether an activity would have that effect is at the Company’s absolute discretion." },
      { p: "Outside your working hours you must not carry out any electrical, building or maintenance work for any other person, including private or cash work, without the prior written consent of a director. Consent will not be unreasonably withheld." },
      { p: "You must not at any time, during your employment or afterwards, use or disclose to any person, firm or company, to the detriment of the Company or its clients, any confidential information about the Company or its clients, except in the proper course of your duties or where the law permits. Confidential information includes client details, prices and tenders, site information, access codes, alarm and security arrangements, and any trade secrets that come to your knowledge during your employment." }
    ]},
    { id: "property", title: "Return of Company property", items: [
      { p: "When your employment ends for whatever reason, or earlier if the Company asks, you must immediately return all Company property in your possession, custody or control. This includes keys, fuel and payment cards, phones, computer hardware and software, test equipment, tools, plant, site passes, Company vehicles, books, documents and any other papers that belong to the Company or relate to its business or clients. You must not keep any copies. If the Company asks, you must confirm in writing that you have complied with this clause." }
    ]},
    { id: "hs", title: "Health and safety", items: [
      { p: "You must follow the Company’s health and safety policy, all risk assessments and method statements that apply to your work, and any site rules. You must wear and look after the personal protective equipment the Company provides, and report any accident, near miss or unsafe condition straight away. A serious breach of health and safety rules may be treated as gross misconduct." }
    ]},
    { id: "data", title: "Data protection", items: [
      { p: "The Company will collect and process personal data about you in line with its privacy notice, which is given to you with this contract. You are required to sign and date the privacy notice and return it to the office." },
      { p: "During your employment you are likely to process personal data about colleagues, clients, tenants, suppliers and subcontractors. It is a condition of your employment that you process any personal data in line with the Company’s data protection policy." },
      { p: "Failure to comply with the data protection policy may lead to disciplinary action. A serious breach may be treated as gross misconduct and may result in summary dismissal." }
    ]},
    { id: "monitoring", title: "Monitoring", items: [
      { p: "To meet its legal obligations and for other legitimate business reasons set out in the privacy notice, the Company may monitor use of its telephones, mobile phones, email, voicemail, internet and other communication and computer systems, including any personal use, using automated software or other means." },
      { p: "Company vehicles are fitted with telematics that record location, speed, driving behaviour and journey times. This information may be used for safety, client billing, checking timesheets and travel time, and in disciplinary matters.", when: "van" },
      { p: "Monitoring will only be carried out as permitted or required by law, and only for as long as is necessary and justified." }
    ]},
    { id: "training", title: "Training", items: [
      { p: "During your employment you will be required to complete induction, health and safety and other job-related training, including any apprenticeship training. This training is compulsory. The Company will meet its cost, and time spent on it is paid working time." },
      { p: "You will not be required to pay for, or contribute to the cost of, any training that is required for your role." },
      { p: "**Repayment of optional training.** If the Company agrees in writing to fund an external qualification or course that is not required for your role, and you resign or are dismissed for gross misconduct, you must repay the course fees on the following scale. This does not apply to apprenticeship training or compulsory health and safety training.", when: "trainingRepay" },
      { table: { head: ["When your employment ends", "Repayment of course fees"], rows: [
        { cells: ["Within six months of completing the course", "100%"] },
        { cells: ["Six to twelve months after completing the course", "50%"] },
        { cells: ["More than twelve months after completing the course", "None"] }
      ]}, when: "trainingRepay" },
      { cont: "You will be told the cost of the course before it starts, and the Company will confirm in writing that this clause applies to it. Any repayment may be deducted from your final pay under clause {#deductions}.", when: "trainingRepay" }
    ]},
    { id: "changes", title: "Changes to your terms", items: [
      { p: "Any change to the terms of this contract will be agreed with you and confirmed in writing no later than one month after it takes effect." }
    ]},
    { id: "law", title: "Governing law", items: [
      { p: "This contract is governed by the law of England and Wales, and the courts and employment tribunals of England and Wales have exclusive jurisdiction." }
    ]}
  ];

  /* ---------- 48-hour opt-out agreement (VERBATIM) ---------- */
  var OPT_INTRO = "This agreement is between **Mostlane Construction Limited** of Segensworth Business Centre, Fareham, PO15 5RQ (‘the Company’) and **{employeeName}** of {employeeAddress} (‘I’ or ‘me’).";
  var OPT_ITEMS = [
    "I agree that the limit of an average of 48 hours’ work in each working week, set by regulation 4(1) of the Working Time Regulations 1998, will not apply to my employment with the Company.",
    "I have made this agreement voluntarily. I understand that I do not have to sign it, and that I will not be dismissed or suffer any other detriment if I choose not to sign it, or if I end it later.",
    "I may end this agreement at any time by giving the Company seven days’ written notice. I can use the notice at the end of this document to do so.",
    "The Company will keep up-to-date records of the hours I work.",
    "This agreement does not affect my rights under the Working Time Regulations 1998 to rest breaks, daily and weekly rest periods and paid annual leave.",
    "This agreement does not form part of my contract of employment. It takes effect on the date it is signed by both parties."
  ];
  var OPT_END = "To Mostlane Construction Limited: I give seven days’ notice that I am ending my agreement to opt out of the 48-hour maximum average working week under the Working Time Regulations 1998.";

  /* ---------- Company van policy (VERBATIM — "Mostlane Company Vans") ---------- */
  var VAN_PARAS = [
    "You will have use of the company vans as instructed and for **company business use only.**",
    "You will be liable for any HMRC charges and we therefore recommend you keep mileage records to prove it is used for company business and for travel from home to place of work only."
  ];
  var VAN_RULES = [
    "No Private Use",
    "Van is kept in clean condition inside and out at all times",
    "No alterations or additions to radios or other such items",
    "No fixing of any items to dashboard/doors or any other part of the cab",
    "No racking or any other shelving in rear of van unless previously agreed in writing by employer",
    "No Smoking",
    "Vans are fitted with GPS trackers",
    "Weekly check of oil, water and tyres required"
  ];
  var VAN_AFTER = [
    "You will be responsible for any speeding, parking or overloading fines. Any damage to the paintwork or interior of the cab you will be responsible for the cost of repair following estimate from main dealer.",
    "Any disregard to any of these items will result in the use of the company vehicle being removed.",
    "Bluetooth is standard and mobile phone should only be answered hands free and when safe to do so.",
    "A fuel card will be provided for these vehicles only.",
    "An updated copy of your driving licence is required on an annual basis and any points collected through a year must be disclosed.",
    "I confirm I understand the rules and conditions set above and that I will abide and follow these."
  ];

  /* ---------- PPE Issue Record (VERBATIM) ---------- */
  var PPE_NOTE = "Note: This form is intended to assist Mostlane in maintaining a basic record of the PPE issued following their PPE assessment. The assessment should have taken into account all risks arising from their activities / work / premises, also any other realistic control measure that could be taken to make the use of PPE unnecessary. Please note that the form is not intended to be fully comprehensive and may well require other inclusions due to the nature of your specific trade / activities / premises, etc. It is your duty to ensure compliance with the relevant legislation. Should you have any uncertainties in this regard we recommend that you consult the regulations or seek expert help before using this tool.";
  var PPE_CONFIRM = [
    ["A", "Reasons why the PPE is necessary"],
    ["B", "Correct method of using/wearing the PPE"],
    ["C", "Procedures to follow in the event of loss or damage to the PPE"],
    ["D", "Arrangements for cleaning, storage, and repair / replacement of the equipment."],
    ["E", "Recommended times/periods for cleaning, and replacement of the PPE or any components forming part of the PPE"],
    ["F", "Limitations of the PPE (if any)"],
    ["G", "Specific circumstances when the PPE is to be worn, e.g., as detailed in the company safe working procedures or method statements. I also confirm that I have been made aware of my duties under current legislation in relation to the need for me to appropriately use and not abuse the PPE issued to me by my employer in relation to them complying with their legislative duties (see below)."]
  ];
  var PPE_ITEMS = [
    ["Head/Hair", "Hard Hat"],
    ["Eyes/Face", "Safety Glasses"],
    ["Respiratory system", "FP3 Face Masks"],
    ["Hearing", "Ear Defenders"],
    ["Hand/wrist/arms", "Protective Gloves"],
    ["Feet/Legs", "Safety Boots"],
    ["Other misc. e.g. entry to confined spaces, excessive heat or cold, etc", "Hi-vis jacket"]
  ];
  var PPE_EXTRACT = "Extract from The Health & Safety at Work, etc. Act 1974: Part I  7  It shall be the duty of every employee while at work  a  to take reasonable care for the health and safety of himself and other persons who may be affected by his acts or omissions at work; and  b  as regards any duty or requirement imposed on his employer or any other person by or under any of the relevant statutory provisions, to co-operate with him so far as is necessary to enable that duty or requirement to be performed or complied with.  8  No person shall intentionally or recklessly interfere with or misuse anything provided in the interests of health, safety or welfare in pursuance of any of the relevant statutory provisions. Brief Explanatory Note - relevant statutory provisions refers to Acts or Regulations, e.g. a Noise assessment may determine that suitable hearing protection must be worn, as other means of control are not viable. The PPE assessment determines the appropriate type of PPE. Once the PPE has been issued then the employee must co-operate and wear the PPE to assist the employer in complying with the duty. Note: for further advice we would recommend that you consult the HSE guidance provided on Personal Protective Equipment at work and the following free leaflet INDG 174 A short guide to Personal Protective Equipment at Work Regulations 1992. This is available from HSE Books.";

  /* ---------- Build a numbered model (VERBATIM) ---------- */
  function build(state) {
    var refs = {}; var blocks = []; var s = 0;
    SECTIONS.forEach(function (sec) {
      if (!ok(state, sec.when)) return;
      s++; refs[sec.id] = String(s);
      blocks.push({ type: "h", num: String(s), text: sec.title });
      var n = 0;
      sec.items.forEach(function (it) {
        if (!ok(state, it.when)) return;
        if (it.p) { n++; var num = s + "." + n; if (it.id) refs[it.id] = num; blocks.push({ type: "p", num: num, text: it.p }); }
        else if (it.sub) {
          var items = it.sub.map(function (x) { return typeof x === "string" ? { t: x } : x; }).filter(function (x) { return ok(state, x.when); });
          blocks.push({ type: "sub", items: items.map(function (x, i) { return { label: "(" + String.fromCharCode(97 + i) + ")", text: x.t }; }) });
        }
        else if (it.table) blocks.push({ type: "table", head: it.table.head, rows: it.table.rows.filter(function (r) { return ok(state, r.when); }).map(function (r) { return r.cells; }) });
        else if (it.cont) blocks.push({ type: "cont", text: it.cont });
      });
    });
    var carry = blocks.find(function (b) { return b.type === "p" && b.text.indexOf("**Carrying holiday over.**") === 0; });
    if (carry) refs.carry = carry.num;
    return { refs: refs, blocks: blocks };
  }

  // Resolve fields/refs but KEEP the literal ** markers (for the portal markup).
  function resolve(text, refs, state, placeholders) {
    return String(text).replace(/\{(#?)(\w+)\}/g, function (m, hash, key) {
      if (hash === "#") return refs[key] || "?";
      var v = val(state, key);
      if (v == null) return placeholders ? ("[" + (LABELS[key] || key) + "]") : "";
      return v;
    });
  }

  /* ---------- Portal signed-document body markup ---------- */
  function markup(state, placeholders) {
    var r = build(state), refs = r.refs, blocks = r.blocks, out = [];
    INTRO.forEach(function (p) { out.push(resolve(p, refs, state, placeholders), ""); });
    blocks.forEach(function (b) {
      if (b.type === "h") out.push("# " + b.num + "  " + b.text, "");
      else if (b.type === "p") out.push(b.num + "  " + resolve(b.text, refs, state, placeholders), "");
      else if (b.type === "sub") { b.items.forEach(function (x) { out.push("- " + x.label + " " + resolve(x.text, refs, state, placeholders)); }); out.push(""); }
      else if (b.type === "table") {
        out.push("| " + b.head.map(function (c) { return resolve(c, refs, state, placeholders); }).join(" | ") + " |");
        out.push("| " + b.head.map(function () { return "---"; }).join(" | ") + " |");
        b.rows.forEach(function (row) { out.push("| " + row.map(function (c) { return resolve(c, refs, state, placeholders); }).join(" | ") + " |"); });
        out.push("");
      }
      else if (b.type === "cont") out.push(resolve(b.text, refs, state, placeholders), "");
    });
    out.push("I confirm that I have received, read, understood and accept this contract of employment, the Staff Handbook and the privacy notice, and I undertake to observe the terms and conditions of employment it contains.");
    return out.join("\n");
  }
  function optMarkup(state, placeholders) {
    var r = {}, out = [];
    out.push("# Working Time Regulations 1998");
    out.push("## Agreement to opt out of the 48-hour maximum working week", "");
    out.push(resolve(OPT_INTRO, r, state, placeholders), "");
    OPT_ITEMS.forEach(function (t, i) { out.push((i + 1) + "  " + resolve(t, r, state, placeholders), ""); });
    out.push("## Notice to end this agreement");
    out.push(resolve(OPT_END, r, state, placeholders));
    return out.join("\n");
  }
  function vanMarkup(state, placeholders) {
    var r = {}, out = [];
    out.push("# Mostlane Company Vans", "");
    VAN_PARAS.forEach(function (p) { out.push(resolve(p, r, state, placeholders), ""); });
    out.push("Use of the company van is on the understanding you abide with these rules:", "");
    VAN_RULES.forEach(function (b) { out.push("- " + b); });
    out.push("");
    VAN_AFTER.forEach(function (p) { out.push(resolve(p, r, state, placeholders), ""); });
    return out.join("\n").replace(/\n+$/, "");
  }
  function ppeMarkup(state, placeholders) {
    var r = {}, out = [];
    var d = resolve("{issueDate}", r, state, placeholders), who = resolve("{issuerName}", r, state, placeholders);
    out.push("# Personal Protective Equipment (PPE) Issue Record", "");
    out.push(PPE_NOTE, "");
    out.push("**Name of Employer/Company:** Mostlane Construction Limited");
    out.push("**Name of Employee:** " + resolve("{employeeName}", r, state, placeholders));
    out.push("**Address of Employee:** " + resolve("{employeeAddress}", r, state, placeholders));
    out.push("**Employees working location:** Various Sites", "");
    out.push("I confirm that I have received the under noted personal protective equipment (PPE). I also confirm that I have received instruction and training in the:", "");
    PPE_CONFIRM.forEach(function (c) { out.push("- **" + c[0] + "**  " + c[1]); });
    out.push("");
    out.push("## PPE issued", "");
    out.push("Person providing instruction and training: " + who + "   ·   Dated: " + d, "");
    out.push("| PPE Issued to Protect to or From | Details of PPE Issued (& If Disposable) | Issue Date | Details of Issuer |");
    out.push("| --- | --- | --- | --- |");
    PPE_ITEMS.forEach(function (it) { out.push("| " + it[0] + " | " + it[1] + " | " + d + " | " + who + " |"); });
    out.push("");
    out.push("## Health & Safety at Work etc. Act 1974 — extract", "");
    out.push(PPE_EXTRACT);
    return out.join("\n");
  }

  /* ---------- HTML preview (same markup rendered to HTML) ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); }
  function inl(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\[([^\]\n]+)\]/g, '<span class="ph">[$1]</span>'); }
  function renderBodyHtml(body) {
    var lines = String(body || "").split(/\r?\n/), html = "", inUl = false, i;
    var closeUl = function () { if (inUl) { html += "</ul>"; inUl = false; } };
    for (i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, "");
      if (!line.trim()) { closeUl(); continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        closeUl(); var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          var cells = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
          if (!cells.every(function (c) { return /^-+$/.test(c) || c === ""; })) rows.push(cells);
          i++;
        }
        i--;
        if (rows.length) {
          html += '<table class="ctbl">';
          rows.forEach(function (rw, ri) {
            html += "<tr>" + rw.map(function (c) { var tag = ri === 0 ? "th" : "td"; return "<" + tag + ">" + inl(c) + "</" + tag + ">"; }).join("") + "</tr>";
          });
          html += "</table>";
        }
        continue;
      }
      if (/^---+$/.test(line.trim())) { closeUl(); html += "<hr>"; continue; }
      if (/^#\s+/.test(line)) { closeUl(); html += "<h3>" + inl(line.replace(/^#\s+/, "")) + "</h3>"; continue; }
      if (/^##\s+/.test(line)) { closeUl(); html += "<h4>" + inl(line.replace(/^##\s+/, "")) + "</h4>"; continue; }
      if (/^[-•]\s+/.test(line)) { if (!inUl) { html += "<ul>"; inUl = true; } html += "<li>" + inl(line.replace(/^[-•]\s+/, "")) + "</li>"; continue; }
      closeUl(); html += "<p>" + inl(line) + "</p>";
    }
    closeUl();
    return html;
  }
  function previewHtml(state) {
    var h = renderBodyHtml(markup(state, true));
    if (state.optOut) {
      h += '<div class="optdiv">Separate agreement — sent as its own signing request (the employee can decline it without affecting the contract).</div>';
      h += renderBodyHtml(optMarkup(state, true));
    }
    return h;
  }

  /* ---------- Missing required fields (respects conditional logic) ---------- */
  function scanMissing(mk) {
    var seen = {}, list = [], m, re = /\[([^\]\n]+)\]/g;
    while ((m = re.exec(mk))) { if (!seen[m[1]]) { seen[m[1]] = 1; list.push(m[1]); } }
    return list;
  }
  function missing(state) {
    var list = scanMissing(markup(state, true));
    if (state.optOut) scanMissing(optMarkup(state, true)).forEach(function (x) { if (list.indexOf(x) < 0) list.push(x); });
    return list;
  }
  // Blank fields the 48-hour opt-out document alone needs (name + address).
  function optMissing(state) { return scanMissing(optMarkup(state, true)); }

  /* ---------- Minimum-wage check ---------- */
  function rate(state) {
    var r = Number(state.hourlyRate);
    var base = "From " + MIN_WAGE.from + ": £" + MIN_WAGE.adult.toFixed(2) + " (21+), £" + MIN_WAGE.age18.toFixed(2) + " (18–20), £" + MIN_WAGE.apprentice.toFixed(2) + " (apprentice rate).";
    if (!state.hourlyRate) return { cls: "", text: base };
    if (r < MIN_WAGE.apprentice) return { cls: "warn", text: "Below every minimum wage rate (£" + MIN_WAGE.apprentice.toFixed(2) + " is the lowest from " + MIN_WAGE.from + ")." };
    if (r < MIN_WAGE.adult) return { cls: "warn", text: "Below £" + MIN_WAGE.adult.toFixed(2) + ". Only lawful if they are under 21, or an apprentice under 19 or in their first year (£" + MIN_WAGE.apprentice.toFixed(2) + ")." };
    return { cls: "", text: "At or above the £" + MIN_WAGE.adult.toFixed(2) + " National Living Wage." };
  }

  function titleFor(state) { var n = val(state, "employeeName"); return "Contract of Employment" + (n ? " — " + n : ""); }
  function optTitleFor(state) { var n = val(state, "employeeName"); return "48-hour Opt-out Agreement" + (n ? " — " + n : ""); }
  function vanTitleFor(state) { var n = val(state, "employeeName"); return "Company Van Policy" + (n ? " — " + n : ""); }
  function ppeTitleFor(state) { var n = val(state, "employeeName"); return "PPE Issue Record" + (n ? " — " + n : ""); }

  /* ---------- Employee Documents: one picker, each sent separately ---------- */
  // id matches the state flag the page toggles (optOut already exists; the
  // others are sendContract / sendVan / sendPpe added to DEFAULTS).
  var DOCS = [
    { id: "contract", flag: "sendContract", label: "Contract of employment", title: titleFor, body: markup },
    { id: "optOut", flag: "optOut", label: "48-hour opt-out", title: optTitleFor, body: optMarkup },
    { id: "van", flag: "sendVan", label: "Company van policy", title: vanTitleFor, body: vanMarkup },
    { id: "ppe", flag: "sendPpe", label: "PPE issue record", title: ppeTitleFor, body: ppeMarkup }
  ];
  function pickedDocs(state) { return DOCS.filter(function (d) { return !!state[d.flag]; }); }
  // The documents to actually send (resolved title + body, placeholders OFF).
  function selectedDocs(state) {
    return pickedDocs(state).map(function (d) {
      return { id: d.id, label: d.label, title: d.title(state), body: d.body(state, false) };
    });
  }
  // Union of blank required fields across the selected documents.
  function missingForDocs(state) {
    var list = [];
    pickedDocs(state).forEach(function (d) {
      scanMissing(d.body(state, true)).forEach(function (x) { if (list.indexOf(x) < 0) list.push(x); });
    });
    return list;
  }
  // Live preview of whichever documents are ticked (each with a divider).
  function previewForDocs(state) {
    var picked = pickedDocs(state);
    if (!picked.length) return '<p style="color:#64748b;padding:24px;text-align:center;">Tick at least one document to send — see <b>Documents to send</b> at the top of the form.</p>';
    return picked.map(function (d, i) {
      var sep = i ? '<div class="optdiv">' + esc(d.label) + ' — separate signing request</div>' : "";
      return sep + renderBodyHtml(d.body(state, true));
    }).join("");
  }

  window.MLContract = {
    MIN_WAGE: MIN_WAGE, DEFAULTS: DEFAULTS, LABELS: LABELS, DOCS: DOCS,
    markup: markup, optMarkup: optMarkup, vanMarkup: vanMarkup, ppeMarkup: ppeMarkup,
    previewHtml: previewHtml, previewForDocs: previewForDocs, renderBodyHtml: renderBodyHtml,
    missing: missing, optMissing: optMissing, missingForDocs: missingForDocs,
    selectedDocs: selectedDocs, pickedDocs: pickedDocs, rate: rate,
    titleFor: titleFor, optTitleFor: optTitleFor, vanTitleFor: vanTitleFor, ppeTitleFor: ppeTitleFor
  };
})();
