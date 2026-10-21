/** Shared business & site configuration — Twin Rivers Fence */
export const site = {
  name: "Twin Rivers Fence",
  localName: "Sacramento Gate Installation",
  domain: "https://gateinstallationsacramento.com",
  phoneDisplay: "(916) 906-2254",
  phoneTel: "+19169062254",
  license: "1089233",
  email: null,
  yearsExperience: 40,
  priceRange: "$$",
  parentUrl: "https://twinriversfence.com/",
  googleReviewsUrl: "https://maps.app.goo.gl/rXBxsJXV2E6Z3Luu6",
  googleMapsUrl: "https://maps.app.goo.gl/rXBxsJXV2E6Z3Luu6",
  hours: "Monday–Friday, 8 AM–5 PM",
  trustLocality: "Sacramento region",
  schemaTypes: ["HomeAndConstructionBusiness","FenceContractor"],
  address: {"locality":"Sacramento","region":"CA","country":"US"},
  geo: {"latitude":38.5816,"longitude":-121.4944},
  areaServed: ["Sacramento","Roseville","Rocklin","Folsom","Elk Grove","Citrus Heights"],
  socialSameAs: [
    "https://maps.app.goo.gl/rXBxsJXV2E6Z3Luu6",
    "https://twinriversfence.com/",
  ],
  ogImage: "https://gateinstallationsacramento.com/favicon-512x512.png",
  themeColor: "#f4f5f7",
  turnstileSiteKey: String(process.env.TURNSTILE_SITE_KEY || "").trim(),
  schemaDescription: "Sacramento gate installation and repair — driveway, automatic, wood, and iron gates. Twin Rivers Fence — licensed #1089233.",
  focus: "gates",
};

export const fenceNavItems = [];
export const gateNavItems = [
  {
    "href": "/gates/",
    "label": "All Gates"
  },
  {
    "href": "/gates/driveway-gates/",
    "label": "Driveway"
  },
  {
    "href": "/gates/automatic-gates/",
    "label": "Automatic"
  },
  {
    "href": "/gates/wood-gates/",
    "label": "Wood"
  },
  {
    "href": "/gates/iron-gates/",
    "label": "Iron"
  },
  {
    "href": "/gates/gate-repair/",
    "label": "Repair"
  }
];
export const deckNavItems = [];
export const patioNavItems = [];
export const serviceNavItems = [
  {
    "href": "/services/gate-installation/",
    "label": "Gate Installation"
  }
];
export const areasNavItems = [
  {
    "href": "/service-areas/",
    "label": "Service Areas"
  }
];
export const toolsNavItems = [];
export const nav = [
  {
    "href": "/gates/",
    "label": "Gates",
    "dropdown": "gates"
  },
  {
    "href": "/custom-gates/",
    "label": "Custom"
  },
  {
    "href": "/service-areas/",
    "label": "Areas"
  },
  {
    "href": "/resources/",
    "label": "Resources"
  },
  {
    "href": "/faq/",
    "label": "FAQ"
  },
  {
    "href": "/#contact",
    "label": "Quote"
  }
];
export const footerColumns = [
  {
    "title": "Gates",
    "links": [
      {
        "href": "/gates/driveway-gates/",
        "label": "Driveway Gates"
      },
      {
        "href": "/gates/automatic-gates/",
        "label": "Automatic"
      },
      {
        "href": "/gates/gate-repair/",
        "label": "Repair"
      }
    ]
  },
  {
    "title": "Company",
    "links": [
      {
        "href": "https://twinriversfence.com/",
        "label": "Twin Rivers Fence"
      },
      {
        "href": "/faq/",
        "label": "FAQ"
      },
      {
        "href": "/privacy/",
        "label": "Privacy"
      },
      {
        "href": "/terms/",
        "label": "Terms"
      }
    ]
  }
];
export const networkLinks = [
  {
    "label": "Twin Rivers Fence (main)",
    "href": "https://twinriversfence.com/"
  },
  {
    "label": "Grass Valley",
    "href": "https://grassvalleyfencing.com/"
  },
  {
    "label": "Rocklin",
    "href": "https://rocklinfencing.com/"
  },
  {
    "label": "Roseville",
    "href": "https://rosevillefencingca.com/"
  },
  {
    "label": "Folsom",
    "href": "https://folsomfencing.com/"
  },
  {
    "label": "Elk Grove",
    "href": "https://elkgrovefencing.com/"
  },
  {
    "label": "Granite Bay",
    "href": "https://granitebayfencing.com/"
  },
  {
    "label": "West Sacramento",
    "href": "https://fencingwestsacramento.com/"
  },
  {
    "label": "Citrus Heights",
    "href": "https://citrusheightsfencing.com/"
  },
  {
    "label": "Sacramento Metro Fencing",
    "href": "https://fencessacramentoca.com/"
  },
  {
    "label": "Sacramento Decks",
    "href": "https://deckbuildingsacramento.com/"
  },
  {
    "label": "Sacramento Gates",
    "href": "https://gateinstallationsacramento.com/"
  }
];
