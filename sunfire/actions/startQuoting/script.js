this.setIndicator("button");

const pluginId = this.args.pluginId;
const [contact, obj, employeePluginConfig] = await Promise.all([
  this.currentEntity(),
  this.currentObject(),
  pluginId ? this.get(`/employee/mine/configs/plugins/${pluginId}`) : Promise.resolve(null),
]);
const business = this.currentBusiness;
const env = this.args.sunfire_env || "prod";
const planType = "MAPD";
const partnerAppId = this.args.partner_app_id || "sunfire";
const baseUrl = env === "qa" ? "https://qa-sunfire.sunfirematrix.com" : "https://www.sunfirematrix.com";

// ─── Helper Functions ────────────────────────────────────────────────────────

const buildDrugValues = (drugNames, drugDisplayNames) => {
  return drugNames.map((name, i) => {
    const parts = name.split("-");
    const ndc = parts[0];
    const qty = parts[1];
    const freq = parts[2];
    const label = drugDisplayNames[i]?.replace(/ \([^)]+\)$/, "");
    return { ndc, name: label, qty: Number(qty) || 0, frequency: Number(freq) || 0 };
  });
};

const buildProviderZipByNpi = (providerRecords) => {
  return Object.fromEntries(
    providerRecords
      .map((r) => [r.name, Object.values(r.fields).find((f) => f.name === "zip")?.value])
      .filter(([, zip]) => zip),
  );
};

const buildProspectBody = (contact, business, fields, { crmPartnerId, partnerAppId, partnerId }) => {
  const body = {
    "applicant.firstName": fields.first_name.value,
    "applicant.lastName": fields.last_name.value,
    "applicant.email": fields.email.value,
    "parameters.kzn_id": contact.id,
    "parameters.kzn_business_id": business.id,
    "metadata.partnerId": partnerId,
    "metadata.app": "blazeconnect",
    "metadata.appId": partnerAppId,
    "metadata.response": "json",
  };

  if (crmPartnerId) {
    body["metadata.crmPartnerId"] = crmPartnerId;
    body["parameters.employee_id"] = business.employee_id;
    body["parameters.partner_app_id"] = partnerAppId;
  }

  let phone = contact.mobile_phone || contact.home_phone || contact.business_phone;
  if (phone && phone.startsWith("+1")) {
    phone = phone.slice(2);
  }
  if (phone) {
    body["applicant.phone.primary"] = phone;
  }

  body["applicant.gender"] = fields.gender?.name[0];
  body["applicant.medicareNumber"] = fields.medicare_number?.value;
  body["applicant.home.line1"] = fields.street_address_1?.value;
  body["applicant.home.city"] = fields.city?.value;
  body["applicant.home.state"] = fields.state?.name;
  body["applicant.home.countyName"] = fields.county?.name;
  body["applicant.home.zip"] = fields.zipcode?.value;
  body["applicant.home.fips"] = fields.fips?.value;

  if (contact.birthday) {
    const parts = contact.birthday.split("-");
    body["applicant.dob.year"] = parts[0];
    body["applicant.dob.month"] = parts[1];
    body["applicant.dob.day"] = parts[2];
  }

  return body;
};

const buildSessionBody = (pharmacyNpis, providerNpis, drugValues, fields, contact) => {
  const body = {
    applicants: [{ type: "primary" }],
  };

  if (pharmacyNpis.length > 0) {
    // Get most recent pharmacy, SunFire only accepts one
    body.pharmacy = { id: pharmacyNpis.at(-1) };
  }

  if (providerNpis.length > 0) {
    body.doctors = providerNpis.map((p) => ({ id: p }));
  }

  if (drugValues.length > 0) {
    body.drugs = drugValues;
  }

  body.applicants[0].gender = fields.gender?.name[0];
  body.zip = fields.zipcode?.value;
  body.county = fields.fips?.value;

  if (contact.birthday) {
    const parts = contact.birthday.split("-");
    body.applicants[0].birthYear = parts[0];
    body.applicants[0].birthMonth = parts[1];
    body.applicants[0].birthDay = parts[2];
  }

  return body;
};

// recursive function for prompt so window stays open when navigating to sunfire profile
const promptForCrmConnectCode = async () => {
  const result = await this.prompt({
    title: "Missing CRM Connect Code",
    confirmButton: {
      label: "Save",
      variant: "standard",
    },
    cancelButton: {
      label: "Generate Code",
      variant: "text",
    },
    content: [
      {
        type: "description",
        content: "Please enter your CRM connect code. This is required to sync provider, drugs, and pharmacy data.",
        widthPercent: 100,
      },
      {
        type: "spacer",
        height: 5,
        widthPercent: 100,
      },
      {
        type: "description",
        content: `Instructions:`,
      },
      {
        type: "description",
        content: "1. Click Generate Code below to log in to your SunFire account and open your profile.",
      },
      {
        type: "description",
        content: "2. In your profile, click Generate your CRM Connect Code, then copy the token.",
      },
      {
        type: "description",
        content: "3. Paste the token into the field below and click Save.",
      },
      {
        type: "spacer",
        height: 10,
        widthPercent: 100,
      },
      {
        type: "text",
        label: "Enter your CRM connect code",
        placeholder: "CRM Connect Code",
        id: "crm_connect_code",
      },
    ],
  });

  if (result.canceled && result.eventSource === "button") {
    await this.openWindow(`${baseUrl}/app/agent/${partnerAppId}/#/agentprofile`);
    return await promptForCrmConnectCode();
  }

  if (!result.canceled && result.values.crm_connect_code) {
    return result.values.crm_connect_code;
  }

  return null;
};

// ─── Field Processing ────────────────────────────────────────────────────────

let fields = {};
let fieldnames = {};
for (const field of obj.fields) {
  fieldnames[field.id] = field.name;
  if (field.is_default) {
    fields[field.name] = {
      field: field.id,
      field_display_name: field.display_name,
      field_type: field.field_type,
      value: contact[field.name],
      name: null,
    };
  }
}

// Build map of field names to values from contact.fields
for (const fieldval of contact.fields) {
  const fieldName = fieldnames[fieldval.field];
  if (!fieldName) continue;

  // Turn multi-value relationship fields into arrays for name, display_name, and value
  if (!fields[fieldName]) {
    fields[fieldName] = fieldval;
  } else if (Array.isArray(fields[fieldName].name)) {
    fields[fieldName].name.push(fieldval.name);
    fields[fieldName].display_name.push(fieldval.display_name);
    fields[fieldName].value.push(fieldval.value);
  } else {
    fields[fieldName] = {
      ...fields[fieldName],
      name: [fields[fieldName].name, fieldval.name],
      display_name: [fields[fieldName].display_name, fieldval.display_name],
      value: [fields[fieldName].value, fieldval.value],
    };
  }
}

// ─── Fire Async Work ─────────────────────────────────────────────────────────

// Session search
const rawSessionNames = fields?.primary_for_saved_session_records?.name;
const sessionNames = [].concat(rawSessionNames ?? []).filter((name) => !name.startsWith("CNX_"));
const sessionNamesFilter = sessionNames.map((name) => ({
  type: "fields_v2",
  subtype: "non_custom",
  field: "name",
  condition: "=",
  value: name,
}));
const ninetyDaysAgo = new Date();
ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
const sessionSearchPromise = this.post("/records/sunfire_saved_sessions/search?ordering=-updated", {
  query: [
    {
      and: true,
      filters: [
        {
          type: "fields_v2",
          subtype: "non_custom",
          field: "created",
          condition: ">=",
          value: ninetyDaysAgo.toISOString(),
        },
      ],
    },
    sessionNamesFilter.length > 0 && {
      and: false,
      filters: sessionNamesFilter,
    },
  ].filter(Boolean),
  and: true,
});

// Provider records
const providersField = obj.fields.find((f) => f.name === "providers");
const providerEntityIds = [].concat(fields.providers?.value ?? []);
const providerRecordsPromise =
  providerEntityIds.length > 0
    ? Promise.all(providerEntityIds.map((id) => this.getEntity(providersField.relation.related_object, id)))
    : Promise.resolve([]);

// Auth (requires CRM connect code — prompt user if not yet saved)
let crmConnectCode = employeePluginConfig?.config?.crm_connect_code;
const crmPartnerId = this.args.crm_partner_id;

if (!crmConnectCode && crmPartnerId) {
  crmConnectCode = await promptForCrmConnectCode();
  if (crmConnectCode) {
    // no patch method for employee config, need to copy existing config and add code
    await this.post(`/employee/mine/configs/plugins/${pluginId}`, {
      config: {
        ...(employeePluginConfig?.config ?? {}),
        crm_connect_code: crmConnectCode,
      },
    });
  } else {
    this.showToast("CRM Connect Code is required to proceed", { variant: "failure" });
    this.setIndicator("none");
    return;
  }
}

const authPromise = crmConnectCode
  ? (async () => {
      const partnerListResponse = await this.post(
        this.getServiceUrl(`auth_${env}`, "/crm/partner/list"),
        { token: crmConnectCode },
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        },
      );

      if (!partnerListResponse || !Array.isArray(partnerListResponse)) {
        throw new Error("Failed to retrieve partner list from SunFire API");
      }

      const clientPartnerId = partnerListResponse.find((p) => p.appId === partnerAppId)?.id;

      if (!clientPartnerId) {
        throw new Error("Failed to retrieve client partner ID from SunFire API");
      }

      const partnerTokenResponse = await this.post(this.getServiceUrl(`auth_${env}`, "/crm/partner/token/load"), {
        type: "authToken",
        clientPartnerId,
      });

      if (!partnerTokenResponse || !partnerTokenResponse.token) {
        throw new Error("Failed to retrieve partner auth token from SunFire API");
      }

      return partnerTokenResponse.token;
    })()
  : Promise.resolve(null);

// ─── Sync Prep ───────────────────────────────────────────────────────────────

const pharmacyNpis = [].concat(fields.pharmacies?.name ?? []);
const providerNpis = [].concat(fields.providers?.name ?? []);
const drugNames = [].concat(fields.drugs?.name ?? []);
const drugDisplayNames = [].concat(fields.drugs?.display_name ?? []);
const drugValues = drugNames.length > 0 ? buildDrugValues(drugNames, drugDisplayNames) : [];

const prospectPostBody = buildProspectBody(contact, business, fields, {
  crmPartnerId,
  partnerAppId,
  partnerId: this.args.partner_id,
});
const sessionPostBody = buildSessionBody(pharmacyNpis, providerNpis, drugValues, fields, contact);

let failedImports = { drugs: [], doctors: [], pharmacy: null };

// ─── Session Prompt ───────────────────────────────────────────────────────────

const sessionIdResponse = await sessionSearchPromise;

const sessionOptions = sessionIdResponse?.results.map((record) => {
  const sessionName = Object.values(record.fields).find((f) => f.name === "name")?.value;
  const sessionUpdated = Object.values(record.fields).find((f) => f.name === "updated")?.value;
  return {
    label: `${sessionName} (Updated ${new Date(sessionUpdated).toLocaleDateString()})`,
    value: sessionName,
  };
});

const sessionPromptContent = [
  {
    type: "description",
    content: "Select a previously saved SunFire session to use for this quote, or create a new session.",
    widthPercent: 100,
  },
  {
    type: "spacer",
    height: 5,
    widthPercent: 100,
  },
  {
    type: "dropdown",
    id: "session_id",
    label: "Select SunFire Session",
    options: sessionOptions,
  },
];

const sessionPromptResponse = await this.prompt({
  title: "Select SunFire Session",
  confirmButton: {
    label: "Continue",
    variant: "standard",
    color: "primary",
  },
  cancelButton: {
    label: "Create New Session",
    variant: "text",
    color: "secondary",
  },
  content: sessionPromptContent,
});

if (sessionPromptResponse.canceled && sessionPromptResponse.eventSource === "close") {
  this.setIndicator("none");
  return;
}
let customer_code = null;
if (!sessionPromptResponse.canceled && sessionPromptResponse.values.session_id) {
  customer_code = sessionPromptResponse.values.session_id.value;
}

let partnerAuthToken = null;
try {
  partnerAuthToken = await authPromise;
} catch (e) {
  this.showToast(e.message, { variant: "failure" });
  return;
}

const providerRecords = await providerRecordsPromise;
const providerZipByNpi = buildProviderZipByNpi(providerRecords);

// If user selected an existing session, we can skip session creation and just open the URL with the existing customer code. Only create a new session if selected "Create New Session".
if (partnerAuthToken && !customer_code) {
  const sessionResponseData = await Promise.race([
    this.post(this.getServiceUrl(`api_${env}`, "/v2/session/external/convert"), sessionPostBody, {
      headers: {
        "X-Proxy-Authorization": partnerAuthToken,
      },
    }),
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ error: true });
      }, 7000);
    }),
  ]);

  if (sessionResponseData && sessionResponseData.errors) {
    if (sessionResponseData.errors.drugs) {
      failedImports.drugs = sessionResponseData.errors.drugs;
    }
    if (sessionResponseData.errors.doctors) {
      failedImports.doctors = sessionResponseData.errors.doctors;
    }
    if (sessionResponseData.errors.pharmacy) {
      failedImports.pharmacy = sessionResponseData.errors.pharmacy;
    }
  }

  if (sessionResponseData.error) {
    this.setIndicator("none");
    this.showToast("Request to SunFire timed out.", { variant: "failure" });
    return;
  }

  customer_code = sessionResponseData.session.customerCode;

  if (sessionResponseData.session?.doctors?.length > 0 && Object.keys(providerZipByNpi).length > 0) {
    // SF returns all provider addresses per NPI, filter to just the one that matches kizen provider record zip.
    // Remove all others through session update. Default to first if no zips match.
    const sessionDoctors = sessionResponseData.session.doctors;

    const npiGroups = sessionDoctors.reduce((acc, doc, idx) => {
      if (!acc[doc.npi]) acc[doc.npi] = [];
      acc[doc.npi].push({ doc, idx });
      return acc;
    }, {});

    const indicesToRemove = [];
    for (const [npi, entries] of Object.entries(npiGroups)) {
      if (entries.length <= 1) continue;
      const expectedZip = providerZipByNpi[npi];
      const matchIdx = entries.findIndex(({ doc }) => doc.address?.zip === expectedZip);
      // If we find a match based on zip, keep that doctor and remove the rest. If no match, just keep the first one and remove the rest.
      const keepIdx = matchIdx !== -1 ? matchIdx : 0;
      entries.forEach(({ idx }, i) => {
        if (i !== keepIdx) indicesToRemove.push(idx);
      });
    }

    if (indicesToRemove.length > 0) {
      // Reverse sort indices so that we remove from the end first and don't mess up the indices of remaining doctors
      indicesToRemove.sort((a, b) => b - a);
      await this.patch(
        this.getServiceUrl(`api_${env}`, "/v2/session"),
        {
          customerCode: customer_code,
          operations: indicesToRemove.map((idx) => ({
            op: "remove",
            path: `/doctors/${idx}`,
          })),
        },
        {
          headers: { "X-Proxy-Authorization": partnerAuthToken },
        },
      );
    }
  }

  await this.post("/records/sunfire_saved_sessions/add", {
    fields: [
      { name: "name", value: customer_code },
      { name: "most_recent_for_applicant", value: { id: contact.id } },
      { name: "applicant", value: { id: contact.id } },
    ],
  });
}

const hasZip = Boolean(prospectPostBody["applicant.home.zip"]);
const hasFips = Boolean(prospectPostBody["applicant.home.fips"]);

const hasInformationForSession = hasZip && hasFips;
const hasFailedImports =
  failedImports.drugs.length > 0 || failedImports.doctors.length > 0 || failedImports.pharmacy !== null;

// Build modal content array
const modalContent = [
  {
    type: "description",
    content: "To avoid overwriting data on other records in SunFire, you must close all open browser tabs to SunFire.",
    widthPercent: 100,
  },
  {
    type: "spacer",
    height: 5,
  },
];

if (!hasZip) {
  modalContent.push(
    {
      type: "description",
      content: "Note: Sunfire requires Zip before quoting.",
      widthPercent: 100,
    },
    {
      type: "spacer",
      height: 5,
    },
  );
}

if (hasFailedImports) {
  modalContent.push(
    {
      type: "spacer",
      height: 5,
    },
    {
      type: "description",
      content: "Warning: Failed to import the following data:",
      widthPercent: 100,
    },
    {
      type: "spacer",
      height: 5,
    },
  );

  if (failedImports.drugs.length > 0) {
    modalContent.push({
      type: "description",
      content: "Drugs:",
      widthPercent: 100,
    });
    failedImports.drugs.forEach((drug) => {
      modalContent.push({
        type: "description",
        content: `  • NDC ${drug.ndc}: ${drug.message}`,
        widthPercent: 100,
      });
    });
    modalContent.push({
      type: "spacer",
      height: 5,
    });
  }

  if (failedImports.doctors.length > 0) {
    modalContent.push({
      type: "description",
      content: "Doctors:",
      widthPercent: 100,
    });
    failedImports.doctors.forEach((doctor) => {
      modalContent.push({
        type: "description",
        content: `  • ${doctor.id || "Unknown"}: ${doctor.message}`,
        widthPercent: 100,
      });
    });
    modalContent.push({
      type: "spacer",
      height: 5,
    });
  }

  if (failedImports.pharmacy !== null) {
    modalContent.push({
      type: "description",
      content: "Pharmacy:",
      widthPercent: 100,
    });
    modalContent.push({
      type: "description",
      content: `  • ${failedImports.pharmacy.id || "Unknown"}: ${failedImports.pharmacy.message}`,
      widthPercent: 100,
    });
  }
}

const promptResponseData = await this.prompt({
  title: "Close SunFire Windows",
  confirmButton: {
    label: "Continue",
    variant: "standard",
    color: "secondary",
  },
  cancelButton: {
    label: "Cancel",
    variant: "text",
    color: "secondary",
  },
  content: modalContent,
});

if (promptResponseData.canceled) {
  this.setIndicator("none");
} else {
  const prospectResponseData = await Promise.race([
    this.post(this.getServiceUrl(`api_${env}`, "/api/prospect"), prospectPostBody, {
      headers: {
        "Content-Type": "application/json",
      },
    }),
    new Promise((resolve) => {
      setTimeout(() => resolve({ error: true }), 7000);
    }),
  ]);

  if (prospectResponseData.error) {
    this.setIndicator("none");
    throw new Error("Request to Sunfire timed out");
  }

  let url = prospectResponseData.url;

  if (customer_code) {
    url += "&cc=" + customer_code;
  }

  if (hasInformationForSession) {
    url =
      url +
      "#/plans" +
      "/" +
      prospectPostBody["applicant.home.zip"] +
      "/" +
      prospectPostBody["applicant.home.fips"] +
      "/" +
      planType;
  } else {
    url = url + "#/quote";
  }

  await this.openWindow(url);
  this.setIndicator("none");
}
