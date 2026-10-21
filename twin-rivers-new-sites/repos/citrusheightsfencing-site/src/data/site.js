/** Shared business & site configuration — Twin Rivers Fence */
export const site = {
  name: "Twin Rivers Fence",
  localName: "Citrus Heights Fence Company",
  domain: "https://citrusheightsfencing.com",
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
  trustLocality: "Sacramento County / Citrus Heights",
  schemaTypes: ["HomeAndConstructionBusiness","FenceContractor"],
  address: {"locality":"Citrus Heights","region":"CA","country":"US"},
  geo: {"latitude":38.7071,"longitude":-121.2811},
  areaServed: ["Citrus Heights","Orangevale","Fair Oaks","Antelope","Carmichael"],
  socialSameAs: [
    "https://maps.app.goo.gl/rXBxsJXV2E6Z3Luu6",
    "https://twinriversfence.com/",
  ],
  ogImage: "https://citrusheightsfencing.com/favicon-512x512.png",
  themeColor: "#f5f8f5",
  turnstileSiteKey: String(process.env.TURNSTILE_SITE_KEY || "").trim(),
  schemaDescription: "Citrus Heights fence company for wood, vinyl, repair, and gates. Twin Rivers Fence — licensed #1089233.",
  focus: "fencing",
};

export const fenceNavItems = [
  {
    "href": "/fence-types/",
    "label": "All Types"
  },
  {
    "href": "/wood-fencing/",
    "label": "Wood"
  },
  {
    "href": "/vinyl-fencing/",
    "label": "Vinyl"
  },
  {
    "href": "/chain-link-fencing/",
    "label": "Chain Link"
  },
  {
    "href": "/fence-types/privacy-fence/",
    "label": "Privacy"
  },
  {
    "href": "/fence-types/pool-fence/",
    "label": "Pool"
  }
];
export const gateNavItems = [
  {
    "href": "/custom-gates/",
    "label": "Custom Gates"
  }
];
export const deckNavItems = [];
export const patioNavItems = [];
export const serviceNavItems = [
  {
    "href": "/services/",
    "label": "All Services"
  },
  {
    "href": "/services/fence-installation/",
    "label": "Installation"
  },
  {
    "href": "/fence-repair/",
    "label": "Repair"
  },
  {
    "href": "/commercial-fencing/",
    "label": "Commercial"
  },
  {
    "href": "/temporary-fence-rental/",
    "label": "Temporary"
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
    "href": "/services/",
    "label": "Services",
    "dropdown": "services"
  },
  {
    "href": "/fence-types/",
    "label": "Fencing",
    "dropdown": "fencing"
  },
  {
    "href": "/custom-gates/",
    "label": "Gates"
  },
  {
    "href": "/commercial-fencing/",
    "label": "Commercial"
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
    "title": "Services",
    "links": [
      {
        "href": "/services/fence-installation/",
        "label": "Installation"
      },
      {
        "href": "/fence-repair/",
        "label": "Repair"
      },
      {
        "href": "/commercial-fencing/",
        "label": "Commercial"
      },
      {
        "href": "/custom-gates/",
        "label": "Gates"
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
