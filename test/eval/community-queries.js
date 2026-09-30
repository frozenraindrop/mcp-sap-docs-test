// Starter query set for the SAP Community leg (see DESIGN-judged-pools-and-community-harness.md).
//
// Community's job is different from the doc corpus: error messages, symptoms, "how do I" and
// workarounds, phrased the way people ask. Curated and synthetic on purpose: no user data, nothing
// harvested from real sessions. EXTEND IT (aim for 30-50) with real-shaped questions before drawing
// conclusions; 12 queries gives very wide confidence intervals.
//
// No gold answers: the judged-pool eval grades whatever a strategy returns.

export default [
  { id: "cap-hana-deploy", category: "cap", query: "CAP cds deploy to HANA fails with HDI container error" },
  { id: "cap-403-xsuaa", category: "cap", query: "CAP service returns 403 forbidden with XSUAA scopes and @requires" },
  { id: "cap-mtx-onboarding", category: "cap", query: "CAP multitenant subscription onboarding fails mtx sidecar" },
  { id: "abap-dump-timeout", category: "abap", query: "ABAP short dump TIME_OUT in report after select inside loop" },
  { id: "abap-unit-mock-select", category: "abap", query: "ABAP unit test how to mock database select with CDS test double" },
  { id: "abap-amdp-slow", category: "abap", query: "AMDP method slow runtime HANA calculation view alternative" },
  { id: "rap-draft-activate", category: "rap", query: "RAP managed draft activate action fails validation message not shown" },
  { id: "cds-ui-lineitem", category: "cds", query: "CDS annotation @UI.lineItem not displayed in Fiori elements list report" },
  { id: "ui5-odata-v4-binding", category: "ui5", query: "UI5 OData V4 model binding not updating after create" },
  { id: "ui5-csp-inline", category: "ui5", query: "UI5 app content security policy error inline script blocked" },
  { id: "flp-tile-missing", category: "fiori", query: "Fiori launchpad tile not showing target mapping missing" },
  { id: "btp-destination-401", category: "btp", query: "BTP destination 401 unauthorized calling on-premise system through cloud connector" },
];
