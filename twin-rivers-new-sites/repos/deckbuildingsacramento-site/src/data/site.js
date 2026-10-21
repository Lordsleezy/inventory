/** Shared business & site configuration — Twin Rivers Fence */
export const site = {
  name: "Twin Rivers Fence",
  localName: "Sacramento Deck Builders",
  domain: "https://deckbuildingsacramento.com",
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
  schemaTypes: ["HomeAndConstructionBusiness"],
  address: {"locality":"Sacramento","region":"CA","country":"US"},
  geo: {"latitude":38.5816,"longitude":-121.4944},
  areaServed: ["Sacramento","West Sacramento","Citrus Heights","Carmichael","Fair Oaks"],
  socialSameAs: [
    "https://maps.app.goo.gl/rXBxsJXV2E6Z3Luu6",
    "https://twinriversfence.com/",
  ],
  ogImage: "https://deckbuildingsacramento.com/favicon-512x512.png",
  themeColor: "#f7f2ea",
  turnstileSiteKey: String(process.env.TURNSTILE_SITE_KEY || "").trim(),
  schemaDescription: "Sacramento deck building and repair — wood, composite, and redwood decks with railings and pergolas. Twin Rivers Fence — licensed #1089233.",
  focus: "decks",
};

export const fenceNavItems = [];
export const gateNavItems = [];
export const deckNavItems = [
  {
    "href": "/decks/",
    "label": "All Decks"
  },
  {
    "href": "/decks/wood-deck/",
    "label": "Wood"
  },
  {
    "href": "/decks/composite-deck/",
    "label": "Composite"
  },
  {
    "href": "/decks/redwood-deck/",
    "label": "Redwood"
  },
  {
    "href": "/decks/deck-railing/",
    "label": "Railing"
  },
  {
    "href": "/decks/pergola/",
    "label": "Pergolas"
  },
  {
    "href": "/decks/deck-repair/",
    "label": "Repair"
  }
];
export const patioNavItems = [];
export const serviceNavItems = [
  {
    "href": "/services/deck-installation/",
    "label": "Deck Installation"
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
    "href": "/decks/",
    "label": "Decks",
    "dropdown": "decks"
  },
  {
    "href": "/services/deck-installation/",
    "label": "Installation"
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
    "title": "Decks",
    "links": [
      {
        "href": "/decks/wood-deck/",
        "label": "Wood Decks"
      },
      {
        "href": "/decks/composite-deck/",
        "label": "Composite"
      },
      {
        "href": "/decks/deck-repair/",
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
