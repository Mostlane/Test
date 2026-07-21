/* ============================================================================
 * ml-perms.js — the ONE source of truth for menu/feature permissions.
 * ----------------------------------------------------------------------------
 * Permissions themselves are issued per-user by the server and cached in
 * `mostlanePermissions` (session/localStorage). This file holds the single
 * mapping of "feature KEY -> permission names that unlock it" that BOTH the
 * office tile grid (main.html) and the field-user app (route/you/…) read, so
 * the two never drift. Holding ANY listed permission unlocks the key;
 * FullAccess unlocks everything. Edit access rules here and nowhere else.
 *
 * Usage:  mlCan("Assets")            -> true/false for the current user
 *         mlCan("EngTimesheet", p)   -> pass an explicit permission object
 * ========================================================================== */
(function () {
  "use strict";
  var MAP = {
    CheckInOut: ["CheckInOut", "CheckIn/Out", "checkinBtn", "checkinhtml"],
    Vehicles: ["Vehicles", "vehiclesBtn"],
    Holiday: ["HolidayRequests", "Holiday", "holidayBtn"],
    EngineersHoursMenu: ["EngineersHoursMenu", "engineersHoursMenu", "engineersHoursMenuBtn"],
    HoursDashboard: ["HoursDashboard", "hours-dashboard-btn"],
    PurchaseOrders: ["PurchaseOrders", "purchaseBtn", "poMenuBtn", "PurchaseOrders2"],
    Sites: ["Sites", "AddSite", "sitesBtn", "Customers"],
    Assets: ["Assets", "Plant&Equipment", "assetsBtn", "assetmenuhtml", "myassetshtml", "assetsadminhtml"],
    MyDocuments: ["MyDocuments", "my-documents-btn"],
    Projects: ["Projects", "ProjectsAccess", "projects", "projectsBtn", "ProjectsAdmin", "ProjectsAdminAccess", "projectsAdmin"],
    HolidayAdmin: ["HolidayAdmin", "HolidayAdminAccess", "holidayAdmin", "HolidayAdminBtn"],
    Weekly: ["Weekly"],
    Forms: ["Forms", "formsBtn"],
    Compliance: ["Compliance", "complianceBtn", "complianceformshtml"],
    Users: ["Users", "usersAdmin", "usersAdminBtn", "DeviceAdmin", "deviceAdmin", "deviceAdminAccess", "deviceadmin"],
    TimesheetAdmin: ["TimesheetAdmin", "TimesheetAdminAccess", "Timesheets", "TimesheetsAdmin", "Payroll", "Office"],
    LabourPlanning: ["LabourPlanning", "labourplanning", "Labour", "Labour Planning", "LabourPlanningAccess"],
    SLA: ["SLA", "SLAAdmin", "slaMenu", "slaAccess"],
    Stats: ["__fullOnly"],
    Notifications: ["__fullOnly"],
    HSPlan: ["HSPlan", "hsPlan", "hsPlanBtn"],
    Customers: ["Sites", "AddSite"],
    PurchaseOrders2: ["PurchaseOrders"],
    SiteLog: ["SiteLog"],
    OfficeTimesheet: ["OfficeTimesheet", "Vehicles"],
    EngTimesheet: ["EngTimesheet"],
    EngTsAdmin: ["TimesheetAdmin"],
    // --- App-only feature keys (not office tiles) ---
    Personalise: ["ThemeColour", "ThemeBackground"]
  };

  function perms(p) {
    if (p && typeof p === "object") return p;
    try { return JSON.parse(sessionStorage.getItem("mostlanePermissions") || localStorage.getItem("mostlanePermissions") || "{}") || {}; }
    catch (e) { return {}; }
  }
  function yes(v) { return String(v || "").toLowerCase() === "yes"; }
  function can(key, p) {
    p = perms(p);
    if (yes(p.FullAccess)) return true;
    var names = MAP[key] || [key];
    return names.some(function (n) { return yes(p[n]); });
  }

  // A "field user" is a jobs/SLA person who isn't an office admin. They land in
  // the engineer app (route.html) at login and navigate the portal from the You
  // screen; office/admins keep main.html. StoryMode counts too (guided engineer).
  function isField(p) {
    p = perms(p);
    if (yes(p.FullAccess) || yes(p.SLAAdmin)) return false;
    return yes(p.SLA) || yes(p.StoryMode);
  }

  // Canonical portal launcher: every area the You screen can surface, gated by
  // the same permission keys as the office tiles (via `can`). Grant a permission
  // and its entry appears on the user's You screen automatically. `always:true`
  // items are personal pages open to any logged-in user (no permission needed).
  var MENU = [
    // Work
    { key: "Assets", href: "my-assets.html", label: "Plant & equipment", icon: "🧰", group: "Work" },
    { always: true, href: "keys.html", label: "Keys signed to me", icon: "🔑", group: "Work" },
    { always: true, href: "van-check.html", label: "Van check", icon: "🚐", group: "Work" },
    { always: true, href: "oncall_current.html", label: "Availability & on-call", icon: "📞", group: "Work" },
    { key: "Vehicles", href: "vehicles.html", label: "Vehicles / fleet", icon: "🛻", group: "Work" },
    { key: "CheckInOut", href: "index.html", label: "Check in / out", icon: "🕒", group: "Work" },
    // Records
    { key: "MyDocuments", href: "my-documents.html", label: "My documents", icon: "📄", group: "Records" },
    { key: "Holiday", href: "holiday.html", label: "Holiday", icon: "🌴", group: "Records" },
    { key: "EngTimesheet", href: "engineer-timesheet.html", label: "My timesheet", icon: "⏱️", group: "Records" },
    { key: "OfficeTimesheet", href: "office-timesheet.html", label: "Office timesheet", icon: "💼", group: "Records" },
    { key: "EngineersHoursMenu", href: "engineers-hours-menu.html", label: "Engineers hours", icon: "🛠️", group: "Records" },
    { key: "Weekly", href: "weekly.html", label: "Weekly summary", icon: "📊", group: "Records" },
    // Portal
    { key: "Forms", href: "forms.html", label: "Forms", icon: "📝", group: "Portal" },
    { key: "Compliance", href: "compliance.html", label: "Compliance", icon: "✔️", group: "Portal" },
    { key: "PurchaseOrders", href: "po.html", label: "PO system", icon: "🧾", group: "Portal" },
    { key: "Sites", href: "sites.html", label: "Manage sites", icon: "📍", group: "Portal" },
    { key: "Projects", href: "projects.html", label: "Projects", icon: "📋", group: "Portal" },
    { key: "HSPlan", href: "hs-docs.html", label: "H&S", icon: "🦺", group: "Portal" },
    { key: "SiteLog", href: "sitelog.html", label: "SiteLog", icon: "🗺️", group: "Portal" },
    // Settings (personal — always available)
    { always: true, href: "notifications.html", label: "Notifications", icon: "🔔", group: "Settings" },
    { always: true, href: "personalise.html", label: "Personalise & settings", icon: "🎨", group: "Settings" },
    { always: true, href: "change-password.html", label: "Password & device", icon: "🔒", group: "Settings" },
    { always: true, href: "help.html", label: "Help & support", icon: "❓", group: "Settings" }
  ];
  // Which MENU entries this user can open (personal items + permitted areas).
  function menuFor(p) {
    p = perms(p);
    return MENU.filter(function (m) { return m.always || can(m.key, p); });
  }

  window.ML_PERM_MAP = MAP;
  window.ML_MENU = MENU;
  window.mlPerms = perms;
  window.mlCan = can;
  window.mlIsFieldUser = isField;
  window.mlMenuFor = menuFor;
})();
