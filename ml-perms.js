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

  window.ML_PERM_MAP = MAP;
  window.mlPerms = perms;
  window.mlCan = can;
})();
