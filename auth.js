// auth.js - Mostlane session guard
(function(){
  const EXPIRY_HOURS = 12;
  const now = Date.now();
  const expiry = localStorage.getItem("mostlaneExpiry");

  // if valid localStorage session, restore into sessionStorage
  if(localStorage.getItem("mostlaneLoggedIn") === "true" && expiry && now < parseInt(expiry)){
    if(!sessionStorage.getItem("mostlaneLoggedIn")){
      sessionStorage.setItem("mostlaneLoggedIn", "true");
      sessionStorage.setItem("mostlaneUser", localStorage.getItem("mostlaneUser"));
    }
  }

  // check expiry or missing login
  if(!localStorage.getItem("mostlaneLoggedIn") || !expiry || now > parseInt(expiry)){
    localStorage.clear();
    sessionStorage.clear();
    if(!location.pathname.endsWith("login.html") && !location.pathname.endsWith("onboard.html")){
      window.location.href = "login.html";
    }
  }
})();