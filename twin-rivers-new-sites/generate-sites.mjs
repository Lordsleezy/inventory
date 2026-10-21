#!/usr/bin/env node
/**
 * Generate five Twin Rivers Fence satellite sites from the Granite Bay scaffold.
 * Research constraint: unique content per site; Sacramento metro site is a hub not a doorway clone.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCAFFOLD = "/tmp/trf-scaffold";
const OUT_ROOT = path.join(__dirname, "repos");

const SHARED = {
  name: "Twin Rivers Fence",
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
};

const NEW_DOMAINS = [
  "fencingwestsacramento.com",
  "deckbuildingsacramento.com",
  "gateinstallationsacramento.com",
  "citrusheightsfencing.com",
  "fencessacramentoca.com",
  "twinriversfence.com",
  "rocklinfencing.com",
  "rosevillefencingca.com",
  "folsomfencing.com",
  "elkgrovefencing.com",
  "granitebayfencing.com",
  "grassvalleyfencing.com",
  "localhost",
];

const NETWORK_LINKS = [
  { label: "Twin Rivers Fence (main)", href: "https://twinriversfence.com/" },
  { label: "Grass Valley", href: "https://grassvalleyfencing.com/" },
  { label: "Rocklin", href: "https://rocklinfencing.com/" },
  { label: "Roseville", href: "https://rosevillefencingca.com/" },
  { label: "Folsom", href: "https://folsomfencing.com/" },
  { label: "Elk Grove", href: "https://elkgrovefencing.com/" },
  { label: "Granite Bay", href: "https://granitebayfencing.com/" },
  { label: "West Sacramento", href: "https://fencingwestsacramento.com/" },
  { label: "Citrus Heights", href: "https://citrusheightsfencing.com/" },
  { label: "Sacramento Metro Fencing", href: "https://fencessacramentoca.com/" },
  { label: "Sacramento Decks", href: "https://deckbuildingsacramento.com/" },
  { label: "Sacramento Gates", href: "https://gateinstallationsacramento.com/" },
];

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function page(p) {
  return p;
}

/** @type {Record<string, any>} */
const SITES = {
  "fencingwestsacramento-site": {
    domain: "https://fencingwestsacramento.com",
    localName: "West Sacramento Fence Company",
    repo: "fencingwestsacramento-site",
    focus: "fencing",
    theme: {
      accent: "#2f6f8f",
      accent2: "#c4a35a",
      ink: "#12232d",
      paper: "#f3f7f9",
      heroGrad: "linear-gradient(135deg, #0e2430 0%, #1e4d63 55%, #2f6f8f 100%)",
    },
    address: { locality: "West Sacramento", region: "CA", country: "US" },
    geo: { latitude: 38.5805, longitude: -121.5302 },
    areaServed: ["West Sacramento", "Broderick", "Bryte", "Southport", "Bridgeway Island"],
    trustLocality: "Yolo County / West Sacramento",
    schemaTypes: ["HomeAndConstructionBusiness", "FenceContractor"],
    schemaDescription:
      "West Sacramento fence company for river-adjacent lots, Southport neighborhoods, and light commercial fencing. Twin Rivers Fence — licensed #1089233.",
    doorwayNote: null,
    home: {
      eyebrow: "West Sacramento, California · Licensed #1089233",
      h1: "West Sacramento Fence Company",
      sub: "West Sacramento Fence Company — free estimates. Call (916) 906-2254 for wood, vinyl, chain link, repairs, and gates across Southport, Broderick, and the river corridor.",
      whoHeading: "A licensed crew that knows West Sacramento lots.",
      whoBody: [
        "Twin Rivers Fence is a California licensed contractor (#1089233) serving West Sacramento with fence installation, repair, gates, and light commercial fencing.",
        "River-adjacent yards, newer Southport tract lots, and industrial parcels near the Port of West Sacramento each need different footing and material choices. We plan for irrigated clay, narrow side yards, and HOA design sheets before we quote.",
      ],
      photoSections: [
        {
          id: "wood",
          tag: "Wood Fence West Sacramento",
          h2: "Privacy that holds up<br>to valley heat.",
          p: "Cedar and redwood privacy lines sized for Southport backyards and older Broderick lots — with posts set for irrigated clay and summer sun.",
          img: "https://images.unsplash.com/photo-1604015641586-6fa03629f976?auto=format&fit=crop&w=1600&q=80",
          alt: "Wood privacy fence along a residential property line",
          side: "left",
        },
        {
          id: "vinyl",
          tag: "Vinyl Fence West Sacramento",
          h2: "Low maintenance.<br>Clean street face.",
          p: "Vinyl privacy and HOA-friendly panels for homeowners who want a durable line without annual staining.",
          img: "https://images.unsplash.com/photo-1593285247650-cd7bb44adcfd?auto=format&fit=crop&w=1600&q=80",
          alt: "Vinyl privacy fence on a residential lot",
          side: "right",
        },
      ],
      services: [
        { href: "/services/fence-installation/", title: "Fence Installation", blurb: "New fence lines for Southport tracts, river corridor lots, and light commercial edges." },
        { href: "/fence-repair/", title: "Fence Repair", blurb: "Leaning posts, storm damage, and gates that no longer latch cleanly." },
        { href: "/custom-gates/", title: "Custom Gates", blurb: "Side-yard walk gates and driveway gates sized for daily use." },
        { href: "/wood-fencing/", title: "Wood Fencing", blurb: "Cedar and redwood privacy built for Sacramento Valley heat." },
        { href: "/vinyl-fencing/", title: "Vinyl Fencing", blurb: "Low-maintenance privacy and pool-adjacent lines." },
        { href: "/commercial-fencing/", title: "Commercial Fencing", blurb: "Security and perimeter fencing for yards and business parcels." },
        { href: "/chain-link-fencing/", title: "Chain Link", blurb: "Practical security for rentals, dog runs, and long boundaries." },
        { href: "/temporary-fence-rental/", title: "Temporary Fence", blurb: "Jobsite panels for construction and short-term boundaries." },
      ],
      areas: ["Southport", "Bridgeway Island", "Broderick", "Bryte", "Riverfront", "Industrial Blvd corridor"],
      faqs: [
        {
          question: "Do you install fences in West Sacramento?",
          answer:
            "Yes. Twin Rivers Fence serves West Sacramento with fence installation, repair, wood, vinyl, chain link, gates, and light commercial fencing. Call (916) 906-2254.",
        },
        {
          question: "Are you licensed in California?",
          answer: "Yes. Twin Rivers Fence holds California contractor license #1089233 and carries insurance for residential and commercial fence work.",
        },
        {
          question: "What areas of West Sacramento do you cover?",
          answer:
            "We work across Southport, Bridgeway Island, Broderick, Bryte, and nearby river-corridor properties. Call with your address to confirm scheduling.",
        },
        {
          question: "Is this the same company as Twin Rivers Fence?",
          answer:
            "Yes. fencingwestsacramento.com is Twin Rivers Fence’s West Sacramento site — same license, same phone, focused on local West Sacramento projects.",
        },
      ],
    },
  },

  "deckbuildingsacramento-site": {
    domain: "https://deckbuildingsacramento.com",
    localName: "Sacramento Deck Builders",
    repo: "deckbuildingsacramento-site",
    focus: "decks",
    theme: {
      accent: "#8b5a2b",
      accent2: "#d4a017",
      ink: "#1f1710",
      paper: "#f7f2ea",
      heroGrad: "linear-gradient(135deg, #1f1710 0%, #4a3220 50%, #8b5a2b 100%)",
    },
    address: { locality: "Sacramento", region: "CA", country: "US" },
    geo: { latitude: 38.5816, longitude: -121.4944 },
    areaServed: ["Sacramento", "West Sacramento", "Citrus Heights", "Carmichael", "Fair Oaks"],
    trustLocality: "Sacramento region",
    schemaTypes: ["HomeAndConstructionBusiness"],
    schemaDescription:
      "Sacramento deck building and repair — wood, composite, and redwood decks with railings and pergolas. Twin Rivers Fence — licensed #1089233.",
    doorwayNote: null,
    capabilityNote:
      "Deck services are already offered on twinriversfence.com and existing city sites (decks/patios IA). This specialty site deepens deck-focused marketing for Sacramento.",
    home: {
      eyebrow: "Sacramento region · Licensed #1089233",
      h1: "Sacramento Deck Building",
      sub: "Wood, composite, and redwood decks — free estimates. Call (916) 906-2254. Built by Twin Rivers Fence for Sacramento Valley homes.",
      whoHeading: "Decks planned for how Sacramento yards are actually used.",
      whoBody: [
        "Twin Rivers Fence builds and repairs decks across the Sacramento region under California contractor license #1089233.",
        "We focus on structure first: footings, ledger connections, guardrails, and fasteners sized for valley heat and occasional winter rain — then finish with the board surface and railing style you want.",
      ],
      photoSections: [
        {
          id: "wood-deck",
          tag: "Wood Decks Sacramento",
          h2: "Outdoor rooms<br>worth using.",
          p: "Raised and ground-level wood decks planned around grade, access, and how you entertain — not a one-size kit.",
          img: "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1600&q=80",
          alt: "Wood deck with outdoor seating",
          side: "left",
        },
        {
          id: "composite",
          tag: "Composite Decks",
          h2: "Less upkeep.<br>More weekends.",
          p: "Composite decking options for homeowners who want outdoor living space without annual staining cycles.",
          img: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1600&q=80",
          alt: "Modern outdoor deck living space",
          side: "right",
        },
      ],
      services: [
        { href: "/decks/wood-deck/", title: "Wood Decks", blurb: "Cedar and pressure-treated systems built for Sacramento Valley conditions." },
        { href: "/decks/composite-deck/", title: "Composite Decks", blurb: "Low-maintenance boards with solid framing underneath." },
        { href: "/decks/redwood-deck/", title: "Redwood Decks", blurb: "Classic redwood surfaces with modern fastening details." },
        { href: "/decks/deck-railing/", title: "Deck Railing", blurb: "Code-minded guardrails that match the deck and house." },
        { href: "/decks/pergola/", title: "Pergolas", blurb: "Shade structures that pair with new or existing decks." },
        { href: "/decks/deck-repair/", title: "Deck Repair", blurb: "Board replacement, railing fixes, and structural repairs." },
        { href: "/services/deck-installation/", title: "Deck Installation", blurb: "Full new builds from footing layout to finish." },
        { href: "/resources/deck-cost-guide/", title: "Deck Cost Guide", blurb: "How Sacramento deck pricing usually breaks down." },
      ],
      areas: ["Land Park", "East Sacramento", "Natomas", "Carmichael", "Fair Oaks", "Citrus Heights", "West Sacramento"],
      faqs: [
        {
          question: "Do you build decks in Sacramento?",
          answer:
            "Yes. Twin Rivers Fence builds and repairs wood, composite, and redwood decks in the Sacramento region. Call (916) 906-2254 for a free estimate.",
        },
        {
          question: "Are you a licensed contractor?",
          answer: "Yes. Work is performed under California contractor license #1089233.",
        },
        {
          question: "Do you also install fencing?",
          answer:
            "Yes. Twin Rivers Fence is primarily a fencing contractor and also builds decks and related outdoor structures. Fence projects can be quoted separately or coordinated with a deck build.",
        },
        {
          question: "Do calculators on this site provide final pricing?",
          answer:
            "No. Online tools are educational only. Binding pricing requires a site-specific quote after we see grade, access, and attachment conditions.",
        },
      ],
    },
  },

  "gateinstallationsacramento-site": {
    domain: "https://gateinstallationsacramento.com",
    localName: "Sacramento Gate Installation",
    repo: "gateinstallationsacramento-site",
    focus: "gates",
    theme: {
      accent: "#3d4450",
      accent2: "#b08d57",
      ink: "#12141a",
      paper: "#f4f5f7",
      heroGrad: "linear-gradient(135deg, #12141a 0%, #2a303a 45%, #4a5564 100%)",
    },
    address: { locality: "Sacramento", region: "CA", country: "US" },
    geo: { latitude: 38.5816, longitude: -121.4944 },
    areaServed: ["Sacramento", "Roseville", "Rocklin", "Folsom", "Elk Grove", "Citrus Heights"],
    trustLocality: "Sacramento region",
    schemaTypes: ["HomeAndConstructionBusiness", "FenceContractor"],
    schemaDescription:
      "Sacramento gate installation and repair — driveway, automatic, wood, and iron gates. Twin Rivers Fence — licensed #1089233.",
    doorwayNote: null,
    home: {
      eyebrow: "Sacramento region · Licensed #1089233",
      h1: "Sacramento Gate Installation",
      sub: "Driveway, automatic, wood, and iron gates — free estimates. Call (916) 906-2254. Installed by Twin Rivers Fence.",
      whoHeading: "Gates engineered for daily use — not just curb appeal.",
      whoBody: [
        "Twin Rivers Fence designs, installs, and repairs gates across the Sacramento region under California contractor license #1089233.",
        "Gate posts see more stress than static fence panels. We size posts, hardware, and operators for swing arc, slide path, driveway grade, and how often the gate actually opens.",
      ],
      photoSections: [
        {
          id: "driveway",
          tag: "Driveway Gates",
          h2: "Entries that work<br>every day.",
          p: "Swing and slide driveway gates planned for vehicle clearance, approach angle, and reliable latching.",
          img: "https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&w=1600&q=80",
          alt: "Residential driveway entrance with gate",
          side: "left",
        },
        {
          id: "auto",
          tag: "Automatic Gates",
          h2: "Operators, remotes,<br>and keypads.",
          p: "Automatic openers and access controls installed with posts and leaves built to handle the motion cycle.",
          img: "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1600&q=80",
          alt: "Metal gate hardware detail",
          side: "right",
        },
      ],
      services: [
        { href: "/gates/driveway-gates/", title: "Driveway Gates", blurb: "Single and dual-leaf entries sized for real vehicle traffic." },
        { href: "/gates/automatic-gates/", title: "Automatic Gates", blurb: "Operators, remotes, keypads, and opener service." },
        { href: "/gates/wood-gates/", title: "Wood Gates", blurb: "Side-yard and privacy gates matched to wood fence lines." },
        { href: "/gates/iron-gates/", title: "Iron Gates", blurb: "Ornamental and security iron for residential entries." },
        { href: "/gates/gate-repair/", title: "Gate Repair", blurb: "Sagging leaves, broken latches, and hardware upgrades." },
        { href: "/custom-gates/", title: "Custom Gates", blurb: "Fabrication for non-standard openings and mixed materials." },
        { href: "/services/gate-installation/", title: "Gate Installation", blurb: "New installs coordinated with fence lines or stand-alone." },
        { href: "/resources/automatic-gate-guide/", title: "Automatic Gate Guide", blurb: "What to plan before you buy an operator." },
      ],
      areas: ["Sacramento", "Natomas", "Roseville", "Rocklin", "Folsom", "Elk Grove", "Citrus Heights", "Granite Bay"],
      faqs: [
        {
          question: "Do you install automatic driveway gates in Sacramento?",
          answer:
            "Yes. Twin Rivers Fence installs and services automatic swing and slide gate operators with matching gate leaves. Call (916) 906-2254.",
        },
        {
          question: "Can you repair a sagging side-yard gate?",
          answer:
            "Yes. We repair and rebuild walk gates and driveway gates, including posts, hinges, latches, and operators when needed.",
        },
        {
          question: "Are you licensed?",
          answer: "Yes. California contractor license #1089233.",
        },
        {
          question: "Do you also build the fence connected to the gate?",
          answer:
            "Yes. Twin Rivers Fence installs fencing and gates. Many projects include both; we can also replace only the gate when the fence line is sound.",
        },
      ],
    },
  },

  "citrusheightsfencing-site": {
    domain: "https://citrusheightsfencing.com",
    localName: "Citrus Heights Fence Company",
    repo: "citrusheightsfencing-site",
    focus: "fencing",
    theme: {
      accent: "#2f6b4f",
      accent2: "#c27a3a",
      ink: "#142019",
      paper: "#f5f8f5",
      heroGrad: "linear-gradient(135deg, #142019 0%, #1f4a38 50%, #2f6b4f 100%)",
    },
    address: { locality: "Citrus Heights", region: "CA", country: "US" },
    geo: { latitude: 38.7071, longitude: -121.2811 },
    areaServed: ["Citrus Heights", "Orangevale", "Fair Oaks", "Antelope", "Carmichael"],
    trustLocality: "Sacramento County / Citrus Heights",
    schemaTypes: ["HomeAndConstructionBusiness", "FenceContractor"],
    schemaDescription:
      "Citrus Heights fence company for wood, vinyl, repair, and gates. Twin Rivers Fence — licensed #1089233.",
    doorwayNote: null,
    home: {
      eyebrow: "Citrus Heights, California · Licensed #1089233",
      h1: "Citrus Heights Fence Company",
      sub: "Citrus Heights Fence Company — free estimates. Call (916) 906-2254 for wood, vinyl, repairs, and gates along Sunrise, Greenback, and nearby neighborhoods.",
      whoHeading: "Local fencing for Citrus Heights yards and side streets.",
      whoBody: [
        "Twin Rivers Fence is a licensed contractor (#1089233) serving Citrus Heights with fence installation, repair, vinyl and wood privacy lines, and gates.",
        "Older neighborhoods near Arcade Creek and established tracts along Greenback Boulevard often need post work in mixed soils plus gates that still clear uneven concrete paths. We quote from the property — not a generic package.",
      ],
      photoSections: [
        {
          id: "privacy",
          tag: "Privacy Fence Citrus Heights",
          h2: "Backyard privacy<br>done cleanly.",
          p: "Board-on-board and standard privacy lines for Citrus Heights homes that need a finished look from both sides.",
          img: "https://images.unsplash.com/photo-1604015641586-6fa03629f976?auto=format&fit=crop&w=1600&q=80",
          alt: "Residential privacy fence",
          side: "left",
        },
        {
          id: "repair",
          tag: "Fence Repair",
          h2: "Fix the lean.<br>Keep the line.",
          p: "Post replacement, panel repair, and gate rebuilds when a full tear-out is not required.",
          img: "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1600&q=80",
          alt: "Fence hardware and repair work",
          side: "right",
        },
      ],
      services: [
        { href: "/services/fence-installation/", title: "Fence Installation", blurb: "New residential fence lines sized for Citrus Heights lots." },
        { href: "/fence-repair/", title: "Fence Repair", blurb: "Posts, panels, and gates repaired without unnecessary full replacement." },
        { href: "/wood-fencing/", title: "Wood Fencing", blurb: "Cedar and redwood privacy for valley sun exposure." },
        { href: "/vinyl-fencing/", title: "Vinyl Fencing", blurb: "Low-maintenance privacy and pool-adjacent runs." },
        { href: "/custom-gates/", title: "Gates", blurb: "Side-yard and driveway gates built for daily use." },
        { href: "/chain-link-fencing/", title: "Chain Link", blurb: "Practical boundaries and dog runs." },
        { href: "/commercial-fencing/", title: "Commercial", blurb: "Light commercial and multifamily perimeter work." },
        { href: "/fence-types/pool-fence/", title: "Pool Fencing", blurb: "Code-minded pool barriers with self-latching gates." },
      ],
      areas: ["Sunrise Blvd corridor", "Greenback Blvd", "Arcade Creek area", "Sayonara Drive area", "Orangevale edge", "Antelope edge"],
      faqs: [
        {
          question: "Do you install fences in Citrus Heights?",
          answer: "Yes. Twin Rivers Fence serves Citrus Heights with installation, repair, wood, vinyl, chain link, and gates. Call (916) 906-2254.",
        },
        {
          question: "What nearby cities do you also serve?",
          answer:
            "From Citrus Heights we commonly take projects in Orangevale, Fair Oaks, Antelope, and Carmichael when scheduling fits. Dedicated Twin Rivers sites also cover Roseville, Rocklin, Folsom, and Elk Grove.",
        },
        {
          question: "Are you licensed and insured?",
          answer: "Yes. California contractor license #1089233 with insurance for residential and commercial fence work.",
        },
        {
          question: "Is citrusheightsfencing.com part of Twin Rivers Fence?",
          answer: "Yes. This is Twin Rivers Fence’s Citrus Heights site — same crew and phone number.",
        },
      ],
    },
  },

  "fencessacramentoca-site": {
    domain: "https://fencessacramentoca.com",
    localName: "Sacramento Fence Company",
    repo: "fencessacramentoca-site",
    focus: "metro",
    theme: {
      accent: "#1a4d3e",
      accent2: "#c9a227",
      ink: "#0f1c18",
      paper: "#f2f5f3",
      heroGrad: "linear-gradient(135deg, #0f1c18 0%, #16352c 40%, #1a4d3e 100%)",
    },
    address: { locality: "Sacramento", region: "CA", country: "US" },
    geo: { latitude: 38.5816, longitude: -121.4944 },
    areaServed: ["Sacramento", "Natomas", "Land Park", "East Sacramento", "Pocket", "Midtown"],
    trustLocality: "City of Sacramento",
    schemaTypes: ["HomeAndConstructionBusiness", "FenceContractor"],
    schemaDescription:
      "Sacramento fence company for city neighborhoods, multifamily, and commercial fencing. Twin Rivers Fence — licensed #1089233. Sister city sites cover Roseville, Rocklin, Folsom, Elk Grove, and more.",
    doorwayNote:
      "RISK FLAG: A Sacramento-wide fencing domain can overlap city sites. This site is intentionally scoped to City of Sacramento neighborhoods + commercial/multifamily, and links users to dedicated Twin Rivers city domains for Roseville/Rocklin/Folsom/Elk Grove/etc. instead of cloning those pages.",
    home: {
      eyebrow: "City of Sacramento · Licensed #1089233",
      h1: "Sacramento Fence Company",
      sub: "Fencing for Sacramento city neighborhoods, multifamily, and commercial sites. Free estimates — call (916) 906-2254. Twin Rivers Fence.",
      whoHeading: "One licensed contractor — city work and commercial scopes.",
      whoBody: [
        "Twin Rivers Fence serves Sacramento under California contractor license #1089233. This site focuses on City of Sacramento residential neighborhoods and commercial or multifamily fencing — not thin copies of our Placer or Elk Grove city sites.",
        "Need Roseville, Rocklin, Folsom, Elk Grove, Grass Valley, or Granite Bay specifically? Use those Twin Rivers city sites for local pages. Need Sacramento city or commercial help? Start here or call (916) 906-2254.",
      ],
      photoSections: [
        {
          id: "residential",
          tag: "Sacramento Residential",
          h2: "Neighborhood fencing<br>with clear scopes.",
          p: "Privacy and repair work for Land Park, East Sac, Pocket, Natomas, and Midtown-adjacent lots — quoted from the actual line.",
          img: "https://images.unsplash.com/photo-1604015641586-6fa03629f976?auto=format&fit=crop&w=1600&q=80",
          alt: "Residential wood fence",
          side: "left",
        },
        {
          id: "commercial",
          tag: "Commercial & Multifamily",
          h2: "Perimeters that<br>protect the schedule.",
          p: "Security chain link, ornamental frontage, temporary jobsite panels, and multifamily edge fencing with clear communication.",
          img: "https://images.unsplash.com/photo-1503387762-592deb58ef4e?auto=format&fit=crop&w=1600&q=80",
          alt: "Commercial construction site perimeter",
          side: "right",
        },
      ],
      services: [
        { href: "/services/residential-fencing/", title: "Residential Fencing", blurb: "City-lot privacy, repair, and replacement." },
        { href: "/commercial-fencing/", title: "Commercial Fencing", blurb: "Business parcels, yards, and security perimeters." },
        { href: "/services/multifamily-fencing/", title: "Multifamily Fencing", blurb: "Apartment and HOA-community consistent lines." },
        { href: "/temporary-fence-rental/", title: "Temporary Fence", blurb: "Construction and event panels." },
        { href: "/fence-repair/", title: "Fence Repair", blurb: "Fast assessment when a full rebuild is not needed." },
        { href: "/custom-gates/", title: "Gates", blurb: "Walk and driveway gates for city and commercial sites." },
        { href: "/wood-fencing/", title: "Wood Fencing", blurb: "Cedar and redwood for Sacramento heat." },
        { href: "/resources/sacramento-fence-permits/", title: "Permit Guidance", blurb: "High-level City of Sacramento permit orientation." },
      ],
      areas: ["Natomas", "Land Park", "East Sacramento", "Midtown / grid edge", "Pocket / Greenhaven", "South Sacramento", "Arden-Arcade edge"],
      cityNetworkNote: true,
      faqs: [
        {
          question: "Do you fence properties inside the City of Sacramento?",
          answer:
            "Yes. Twin Rivers Fence handles residential, multifamily, and commercial fencing in Sacramento. Call (916) 906-2254.",
        },
        {
          question: "How is this different from your Roseville or Folsom sites?",
          answer:
            "Those sites focus on their cities. fencessacramentoca.com focuses on Sacramento city neighborhoods and commercial/multifamily work, and points Placer or Elk Grove homeowners to the matching Twin Rivers city site.",
        },
        {
          question: "Are you licensed?",
          answer: "Yes. California contractor license #1089233.",
        },
        {
          question: "Do you invent project counts or review scores on this site?",
          answer:
            "No. We stick to verified facts: license, phone, hours, and our Google Business Profile link. Ask us for references from recent local work.",
        },
      ],
    },
  },
};

function buildPages(siteKey, cfg) {
  const city = cfg.address.locality;
  const brand = cfg.localName;
  const L = cfg.license;
  const pages = [];

  const add = (p) => pages.push(page(p));

  if (cfg.focus === "decks") {
    add({
      path: "/decks/",
      type: "hub",
      title: `Deck Builder Sacramento | Wood & Composite | ${brand}`,
      description: `Deck construction and repair in Sacramento. Wood, composite, redwood, railings, and pergolas. Twin Rivers Fence — licensed #${L}.`,
      h1: "Deck Building in Sacramento",
      eyebrow: "Outdoor living",
      intro:
        "Twin Rivers Fence builds and repairs decks across the Sacramento region — wood, composite, and redwood systems with railings and shade structures planned for valley heat and real yard grade.",
      sections: [
        {
          heading: "What we build",
          paragraphs: [
            "New deck construction, board replacement, railing upgrades, and structural repairs. We coordinate footings and ledger details so the deck works with existing doors, fences, and drainage.",
            "Online estimates are educational only. Final pricing requires a site visit.",
          ],
          bullets: ["Wood decks", "Composite decks", "Redwood decks", "Railings & pergolas", "Deck repair"],
        },
      ],
      faqs: cfg.home.faqs.slice(0, 3),
      related: [
        { href: "/decks/wood-deck/", label: "Wood Decks" },
        { href: "/decks/composite-deck/", label: "Composite Decks" },
        { href: "/#contact", label: "Request a Quote" },
      ],
    });
    const deckTypes = [
      ["wood-deck", "Wood Decks", "Cedar and treated framing with board surfaces chosen for sun exposure and budget."],
      ["composite-deck", "Composite Decks", "Low-maintenance composite boards over solid framing."],
      ["redwood-deck", "Redwood Decks", "Redwood surfaces with modern fasteners and careful detailing."],
      ["deck-railing", "Deck Railing", "Guardrails planned for code height and a clean finished look."],
      ["pergola", "Pergolas", "Shade structures that pair with new or existing decks."],
      ["deck-repair", "Deck Repair", "Replace failed boards, tighten structure, and restore safe railings."],
    ];
    for (const [slug, title, intro] of deckTypes) {
      add({
        path: `/decks/${slug}/`,
        type: "service",
        title: `${title} Sacramento | Twin Rivers Fence`,
        description: `${title} in Sacramento by Twin Rivers Fence. Licensed #${L}. Free estimates — call (916) 906-2254.`,
        h1: `${title} in Sacramento`,
        eyebrow: brand,
        intro,
        sections: [
          {
            heading: "How we approach the work",
            paragraphs: [
              `Every ${title.toLowerCase()} project starts with access, grade, and attachment conditions — not a catalog photo.`,
              "We confirm permit needs with you when the jurisdiction requires them and write a clear scope before materials are ordered.",
            ],
          },
        ],
        faqs: [
          {
            question: `Do you install ${title.toLowerCase()} near ${city}?`,
            answer: `Yes. Twin Rivers Fence handles ${title.toLowerCase()} in the Sacramento region under license #${L}. Call (916) 906-2254.`,
          },
        ],
        related: [
          { href: "/decks/", label: "All Decks" },
          { href: "/#contact", label: "Get a Quote" },
        ],
      });
    }
    add({
      path: "/services/deck-installation/",
      type: "service",
      title: `Deck Installation Sacramento | Twin Rivers Fence`,
      description: `Professional deck installation in Sacramento. Twin Rivers Fence — licensed #${L}.`,
      h1: "Deck Installation",
      eyebrow: "Full builds",
      intro: "From footing layout to finished surface, we install decks built for how you will use the space.",
      sections: [
        {
          heading: "Process",
          paragraphs: [
            "Site visit and measurements, written scope, material lead times, installation, and a walkthrough.",
            "Hours: Monday–Friday, 8 AM–5 PM. Call (916) 906-2254.",
          ],
        },
      ],
      faqs: [],
      related: [{ href: "/decks/", label: "Deck options" }],
    });
    add({
      path: "/resources/",
      type: "hub",
      title: `Sacramento Deck Resources | ${brand}`,
      description: `Deck planning guides for Sacramento homeowners from Twin Rivers Fence.`,
      h1: "Deck Resource Center",
      eyebrow: "Guides",
      intro: "Practical planning notes — not filler blog posts.",
      sections: [
        {
          heading: "Start here",
          paragraphs: ["Use the cost guide for ballpark expectations, then request a site visit for real numbers."],
        },
      ],
      related: [
        { href: "/resources/deck-cost-guide/", label: "Deck Cost Guide" },
        { href: "/faq/", label: "FAQ" },
      ],
    });
    add({
      path: "/resources/deck-cost-guide/",
      type: "resource",
      title: `Sacramento Deck Cost Guide | Twin Rivers Fence`,
      description: `How Sacramento deck costs usually break down. Educational ranges only — licensed #${L}.`,
      h1: "Sacramento Deck Cost Guide",
      eyebrow: "Planning",
      intro: "Deck pricing varies with height, railing, material, access, and attachment details. This guide explains the cost drivers — it is not a bid.",
      sections: [
        {
          heading: "What changes the number",
          bullets: ["Material (wood vs composite vs redwood)", "Height and footing complexity", "Railing style", "Demo of an existing deck", "Permit requirements"],
          paragraphs: ["Call (916) 906-2254 for a free on-site estimate from Twin Rivers Fence."],
        },
      ],
      faqs: [],
      related: [{ href: "/#contact", label: "Request a Quote" }],
    });
    add({
      path: "/service-areas/",
      type: "hub",
      title: `Sacramento Deck Service Areas | Twin Rivers Fence`,
      description: `Deck building service areas for Twin Rivers Fence in the Sacramento region.`,
      h1: "Service Areas",
      eyebrow: "Where we work",
      intro: "We take deck projects across Sacramento and nearby communities when the schedule and scope are a good fit.",
      sections: [
        {
          heading: "Communities",
          bullets: cfg.areaServed,
          paragraphs: ["Dedicated Twin Rivers fence city sites remain the right entry point for fence-only work in Roseville, Rocklin, Folsom, and Elk Grove."],
        },
      ],
      related: [{ href: "/#contact", label: "Confirm your address" }],
    });
  } else if (cfg.focus === "gates") {
    add({
      path: "/gates/",
      type: "hub",
      title: `Gate Installation Sacramento | Driveway & Automatic | Twin Rivers Fence`,
      description: `Gate installation and repair in Sacramento: driveway, automatic, wood, and iron. Licensed #${L}.`,
      h1: "Gate Installation in Sacramento",
      eyebrow: "Walk & drive gates",
      intro:
        "Twin Rivers Fence installs and repairs driveway, automatic, wood, and iron gates across the Sacramento region — with posts and hardware sized for daily cycles, not just appearance.",
      sections: [
        {
          heading: "Gate types",
          bullets: ["Driveway swing and slide gates", "Automatic operators and keypads", "Wood side-yard gates", "Iron and ornamental gates", "Gate repair"],
          paragraphs: ["Hours: Monday–Friday, 8 AM–5 PM. Call (916) 906-2254."],
        },
      ],
      faqs: cfg.home.faqs.slice(0, 3),
      related: [
        { href: "/gates/automatic-gates/", label: "Automatic Gates" },
        { href: "/gates/driveway-gates/", label: "Driveway Gates" },
      ],
    });
    const gateTypes = [
      ["driveway-gates", "Driveway Gates", "Vehicle entries planned for clearance, grade, and reliable latching."],
      ["automatic-gates", "Automatic Gates", "Operators, remotes, and keypads installed on properly built leaves and posts."],
      ["wood-gates", "Wood Gates", "Side-yard and privacy gates matched to wood fence lines."],
      ["iron-gates", "Iron Gates", "Ornamental and security iron for residential and light commercial entries."],
      ["gate-repair", "Gate Repair", "Fix sagging leaves, hinges, latches, and operators."],
    ];
    for (const [slug, title, intro] of gateTypes) {
      add({
        path: `/gates/${slug}/`,
        type: "service",
        title: `${title} Sacramento | Twin Rivers Fence`,
        description: `${title} in Sacramento by Twin Rivers Fence. Licensed #${L}. Call (916) 906-2254.`,
        h1: `${title} in Sacramento`,
        eyebrow: brand,
        intro,
        sections: [
          {
            heading: "Built for motion",
            paragraphs: [
              "Gate posts are oversized relative to static fence posts because moving leaves create repeated load.",
              "We confirm swing arcs, slide paths, and opener clearances before fabrication.",
            ],
          },
        ],
        faqs: [
          {
            question: `Do you handle ${title.toLowerCase()} in Sacramento?`,
            answer: `Yes. Twin Rivers Fence provides ${title.toLowerCase()} under license #${L}. Call (916) 906-2254.`,
          },
        ],
        related: [
          { href: "/gates/", label: "All Gates" },
          { href: "/#contact", label: "Get a Quote" },
        ],
      });
    }
    add({
      path: "/custom-gates/",
      type: "service",
      title: `Custom Gates Sacramento | Twin Rivers Fence`,
      description: `Custom gate fabrication and installation in Sacramento. Licensed #${L}.`,
      h1: "Custom Gates",
      eyebrow: "Fabrication",
      intro: "Non-standard openings, mixed materials, and matching fence lines — built to the opening you actually have.",
      sections: [{ heading: "Process", paragraphs: ["Measure, design, fabricate or source, install, adjust, and walk through operation with you."] }],
      faqs: [],
      related: [{ href: "/gates/", label: "Gate options" }],
    });
    add({
      path: "/services/gate-installation/",
      type: "service",
      title: `Gate Installation Service Sacramento | Twin Rivers Fence`,
      description: `Professional gate installation in Sacramento. Twin Rivers Fence #${L}.`,
      h1: "Gate Installation Service",
      eyebrow: "Install",
      intro: "New gate installs for residential driveways and side yards across the Sacramento region.",
      sections: [{ heading: "Scheduling", paragraphs: ["Business hours Monday–Friday, 8 AM–5 PM. Call (916) 906-2254."] }],
      faqs: [],
      related: [{ href: "/gates/", label: "Gate types" }],
    });
    add({
      path: "/resources/",
      type: "hub",
      title: `Sacramento Gate Resources | Twin Rivers Fence`,
      description: `Guides for planning gate installation in Sacramento.`,
      h1: "Gate Resource Center",
      eyebrow: "Guides",
      intro: "Planning notes for homeowners considering driveway or automatic gates.",
      sections: [{ heading: "Guides", paragraphs: ["Start with the automatic gate guide if you want operators."] }],
      related: [{ href: "/resources/automatic-gate-guide/", label: "Automatic Gate Guide" }],
    });
    add({
      path: "/resources/automatic-gate-guide/",
      type: "resource",
      title: `Automatic Gate Guide Sacramento | Twin Rivers Fence`,
      description: `What to plan before installing an automatic gate in Sacramento.`,
      h1: "Automatic Gate Planning Guide",
      eyebrow: "Planning",
      intro: "Operators fail early when leaves and posts are undersized. Plan structure first, then choose the opener.",
      sections: [
        {
          heading: "Checklist",
          bullets: ["Swing vs slide clearance", "Power availability", "Post footing size", "Safety edges and entrapment protection", "Backup access plan"],
          paragraphs: ["Twin Rivers Fence can assess your opening and recommend a practical setup. Call (916) 906-2254."],
        },
      ],
      faqs: [],
      related: [{ href: "/gates/automatic-gates/", label: "Automatic Gates" }],
    });
    add({
      path: "/service-areas/",
      type: "hub",
      title: `Gate Installation Service Areas | Twin Rivers Fence`,
      description: `Sacramento-region service areas for Twin Rivers Fence gate installation.`,
      h1: "Service Areas",
      eyebrow: "Coverage",
      intro: "Gate projects across Sacramento and nearby Twin Rivers markets when scheduling fits.",
      sections: [{ heading: "Areas", bullets: cfg.areaServed, paragraphs: [] }],
      related: [{ href: "/#contact", label: "Request a Quote" }],
    });
  } else {
    // fencing or metro
    const isMetro = cfg.focus === "metro";
    add({
      path: "/services/",
      type: "hub",
      title: isMetro ? `Sacramento Fence Services | Twin Rivers Fence` : `Fence Services in ${city} | Twin Rivers Fence`,
      description: isMetro
        ? `Residential, commercial, and multifamily fencing services in Sacramento. Licensed #${L}.`
        : `Fence installation, repair, wood, vinyl, and gates in ${city}. Twin Rivers Fence — licensed #${L}.`,
      h1: isMetro ? "Sacramento Fence Services" : `Fence Services for ${city}`,
      eyebrow: brand,
      intro: isMetro
        ? "City neighborhood fencing plus commercial and multifamily scopes — with clear routing to Twin Rivers city sites when another city is a better fit."
        : `Most ${city} fence work is residential privacy, repair, and gates. Twin Rivers Fence quotes from your property line, soil, and gate needs.`,
      sections: [
        {
          heading: "Core services",
          bullets: cfg.home.services.map((s) => s.title),
          paragraphs: [`Licensed #${L}. Hours: Monday–Friday, 8 AM–5 PM. Call (916) 906-2254.`],
        },
      ],
      faqs: cfg.home.faqs.slice(0, 3),
      related: cfg.home.services.slice(0, 6).map((s) => ({ href: s.href, label: s.title })),
    });

    const fenceServices = [
      ["/services/fence-installation/", "Fence Installation", `New fence installation for ${city} properties with posts set for local soil and layout.`],
      ["/fence-repair/", "Fence Repair", `Repair leaning posts, damaged panels, and failing gates in ${city}.`],
      ["/wood-fencing/", "Wood Fencing", `Cedar and redwood fencing planned for Sacramento Valley sun and irrigation.`],
      ["/vinyl-fencing/", "Vinyl Fencing", `Low-maintenance vinyl privacy and pool-adjacent lines.`],
      ["/chain-link-fencing/", "Chain Link Fencing", `Practical chain link for boundaries, dog runs, and security.`],
      ["/commercial-fencing/", "Commercial Fencing", `Security and perimeter fencing for business and jobsite needs.`],
      ["/temporary-fence-rental/", "Temporary Fence Rental", `Temporary panels for construction and short-term boundaries.`],
      ["/custom-gates/", "Custom Gates", `Walk and driveway gates coordinated with your fence line.`],
      ["/fence-types/privacy-fence/", "Privacy Fence", `Privacy fencing for backyard seclusion and clean neighbor lines.`],
      ["/fence-types/pool-fence/", "Pool Fence", `Pool barrier fencing with self-latching gate hardware in mind.`],
    ];
    if (isMetro) {
      fenceServices.push([
        "/services/residential-fencing/",
        "Residential Fencing",
        "City-lot residential fencing for Sacramento neighborhoods.",
      ]);
      fenceServices.push([
        "/services/multifamily-fencing/",
        "Multifamily Fencing",
        "Consistent multifamily and community perimeter fencing.",
      ]);
    }
    for (const [pathUrl, title, intro] of fenceServices) {
      add({
        path: pathUrl,
        type: "service",
        title: `${title} ${city} | Twin Rivers Fence`,
        description: `${title} in ${city} by Twin Rivers Fence. Licensed #${L}. Free estimates — (916) 906-2254.`,
        h1: `${title} in ${city}`,
        eyebrow: brand,
        intro,
        sections: [
          {
            heading: "What to expect",
            paragraphs: [
              "We measure, discuss materials, and provide a written scope before work begins.",
              "Binding pricing requires a site visit. Online content is educational.",
            ],
          },
        ],
        faqs: [
          {
            question: `Do you provide ${title.toLowerCase()} in ${city}?`,
            answer: `Yes. Twin Rivers Fence provides ${title.toLowerCase()} in ${city} under license #${L}. Call (916) 906-2254.`,
          },
        ],
        related: [
          { href: "/services/", label: "All Services" },
          { href: "/#contact", label: "Get a Quote" },
        ],
      });
    }

    add({
      path: "/fence-types/",
      type: "hub",
      title: `Fence Types ${city} | Twin Rivers Fence`,
      description: `Fence types available in ${city}: wood, vinyl, privacy, pool, chain link, and more.`,
      h1: `Fence Types for ${city}`,
      eyebrow: "Materials & styles",
      intro: `Choose materials based on maintenance, privacy, and how the yard is used — then confirm HOA or city rules when they apply.`,
      sections: [
        {
          heading: "Common choices",
          bullets: ["Wood privacy", "Vinyl", "Chain link", "Pool barriers", "Ornamental iron (where specified)"],
          paragraphs: [],
        },
      ],
      related: [
        { href: "/wood-fencing/", label: "Wood" },
        { href: "/vinyl-fencing/", label: "Vinyl" },
        { href: "/chain-link-fencing/", label: "Chain Link" },
      ],
    });

    add({
      path: "/resources/",
      type: "hub",
      title: `${city} Fence Resources | Twin Rivers Fence`,
      description: `Fence planning resources for ${city} from Twin Rivers Fence.`,
      h1: "Resource Center",
      eyebrow: "Guides",
      intro: "Practical guides to help you prepare for a quote.",
      sections: [
        {
          heading: "Guides",
          paragraphs: ["Cost expectations and permit orientation — always verify current city requirements."],
        },
      ],
      related: [
        { href: "/resources/fence-cost-guide/", label: "Fence Cost Guide" },
        ...(isMetro
          ? [{ href: "/resources/sacramento-fence-permits/", label: "Sacramento Permits" }]
          : [{ href: "/resources/fence-permit-guide/", label: "Permit Guide" }]),
      ],
    });

    add({
      path: "/resources/fence-cost-guide/",
      type: "resource",
      title: `${city} Fence Cost Guide | Twin Rivers Fence`,
      description: `Educational fence cost drivers for ${city}. Not a bid. Licensed #${L}.`,
      h1: `${city} Fence Cost Guide`,
      eyebrow: "Planning",
      intro: "Linear footage, material, gates, removal, and soil conditions drive price. This page explains the variables.",
      sections: [
        {
          heading: "Cost drivers",
          bullets: ["Material", "Height", "Gates", "Old fence removal", "Access and soil"],
          paragraphs: ["Call (916) 906-2254 for a free estimate."],
        },
      ],
      faqs: [],
      related: [{ href: "/#contact", label: "Request a Quote" }],
    });

    if (isMetro) {
      add({
        path: "/resources/sacramento-fence-permits/",
        type: "resource",
        title: `Sacramento Fence Permits Overview | Twin Rivers Fence`,
        description: `High-level orientation to City of Sacramento fence permitting topics. Verify current rules with the city.`,
        h1: "Sacramento Fence Permits — Overview",
        eyebrow: "Permits",
        intro:
          "Permit rules change. This page is orientation only — confirm height, setback, and permit needs with the City of Sacramento before you build.",
        sections: [
          {
            heading: "What we help with",
            paragraphs: [
              "We can discuss typical height and placement questions during your estimate and help you understand what to ask the city.",
              "We do not invent approvals. Final compliance is based on current city requirements and your property conditions.",
            ],
          },
        ],
        faqs: [
          {
            question: "Do you pull every fence permit automatically?",
            answer:
              "Permit needs depend on the scope and jurisdiction. We discuss requirements during estimating and coordinate when a permit is part of the agreed scope.",
          },
        ],
        related: [{ href: "/#contact", label: "Ask about your address" }],
      });
      add({
        path: "/city-sites/",
        type: "hub",
        title: `Twin Rivers Fence City Sites | Sacramento Network`,
        description: `Dedicated Twin Rivers Fence city websites for Roseville, Rocklin, Folsom, Elk Grove, and more.`,
        h1: "Dedicated City Sites",
        eyebrow: "Network",
        intro:
          "If you need a different Twin Rivers city market, use the dedicated site. This Sacramento site stays focused on city neighborhoods and commercial work.",
        sections: [
          {
            heading: "City websites",
            bullets: [
              "https://rosevillefencingca.com/",
              "https://rocklinfencing.com/",
              "https://folsomfencing.com/",
              "https://elkgrovefencing.com/",
              "https://grassvalleyfencing.com/",
              "https://granitebayfencing.com/",
              "https://fencingwestsacramento.com/",
              "https://citrusheightsfencing.com/",
              "https://twinriversfence.com/",
            ],
            paragraphs: ["Specialty sites: deckbuildingsacramento.com and gateinstallationsacramento.com."],
          },
        ],
        related: [{ href: "/#contact", label: "Or just call us" }],
      });
    } else {
      add({
        path: "/resources/fence-permit-guide/",
        type: "resource",
        title: `${city} Fence Permit Guide | Twin Rivers Fence`,
        description: `High-level fence permit orientation for ${city}. Verify current rules with the local building department.`,
        h1: `${city} Fence Permit Guide`,
        eyebrow: "Permits",
        intro: `Permit and height rules vary. Confirm current requirements with the local building department. Twin Rivers Fence discusses typical needs during estimates.`,
        sections: [
          {
            heading: "Before you build",
            paragraphs: [
              "Check height limits, setbacks, and whether your project needs a permit or HOA approval.",
              "We do not invent approvals — we help you plan a compliant scope.",
            ],
          },
        ],
        faqs: [],
        related: [{ href: "/#contact", label: "Request a Quote" }],
      });
    }

    add({
      path: "/service-areas/",
      type: "hub",
      title: `${brand} Service Areas`,
      description: `Service areas for ${brand}. Twin Rivers Fence licensed #${L}.`,
      h1: "Service Areas",
      eyebrow: "Coverage",
      intro: isMetro
        ? "Primary focus: City of Sacramento neighborhoods listed below. Other Twin Rivers city sites cover their markets."
        : `Primary focus: ${city} and nearby communities when scheduling fits.`,
      sections: [
        {
          heading: "Areas",
          bullets: cfg.home.areas,
          paragraphs: [`Also see areaServed: ${cfg.areaServed.join(", ")}.`],
        },
      ],
      related: [{ href: "/#contact", label: "Confirm coverage" }],
    });
  }

  add({
    path: "/faq/",
    type: "hub",
    title: `FAQ | ${brand}`,
    description: `Frequently asked questions about ${brand} and Twin Rivers Fence.`,
    h1: "Frequently Asked Questions",
    eyebrow: "Answers",
    intro: `Straight answers about licensing, service area, and estimates. Hours: Monday–Friday, 8 AM–5 PM.`,
    sections: [
      {
        heading: "Business facts",
        paragraphs: [
          `Business: Twin Rivers Fence. Phone: (916) 906-2254. License: #${L}. Main site: https://twinriversfence.com/.`,
        ],
      },
    ],
    faqs: cfg.home.faqs,
    related: [{ href: "/#contact", label: "Contact" }],
  });

  return pages;
}

function buildNav(cfg) {
  if (cfg.focus === "decks") {
    return {
      nav: [
        { href: "/decks/", label: "Decks", dropdown: "decks" },
        { href: "/services/deck-installation/", label: "Installation" },
        { href: "/service-areas/", label: "Areas" },
        { href: "/resources/", label: "Resources" },
        { href: "/faq/", label: "FAQ" },
        { href: "/#contact", label: "Quote" },
      ],
      fenceNavItems: [],
      gateNavItems: [],
      deckNavItems: [
        { href: "/decks/", label: "All Decks" },
        { href: "/decks/wood-deck/", label: "Wood" },
        { href: "/decks/composite-deck/", label: "Composite" },
        { href: "/decks/redwood-deck/", label: "Redwood" },
        { href: "/decks/deck-railing/", label: "Railing" },
        { href: "/decks/pergola/", label: "Pergolas" },
        { href: "/decks/deck-repair/", label: "Repair" },
      ],
      patioNavItems: [],
      serviceNavItems: [{ href: "/services/deck-installation/", label: "Deck Installation" }],
      toolsNavItems: [],
      areasNavItems: [{ href: "/service-areas/", label: "Service Areas" }],
      footerColumns: [
        {
          title: "Decks",
          links: [
            { href: "/decks/wood-deck/", label: "Wood Decks" },
            { href: "/decks/composite-deck/", label: "Composite" },
            { href: "/decks/deck-repair/", label: "Repair" },
          ],
        },
        {
          title: "Company",
          links: [
            { href: "https://twinriversfence.com/", label: "Twin Rivers Fence" },
            { href: "/faq/", label: "FAQ" },
            { href: "/privacy/", label: "Privacy" },
            { href: "/terms/", label: "Terms" },
          ],
        },
      ],
    };
  }
  if (cfg.focus === "gates") {
    return {
      nav: [
        { href: "/gates/", label: "Gates", dropdown: "gates" },
        { href: "/custom-gates/", label: "Custom" },
        { href: "/service-areas/", label: "Areas" },
        { href: "/resources/", label: "Resources" },
        { href: "/faq/", label: "FAQ" },
        { href: "/#contact", label: "Quote" },
      ],
      fenceNavItems: [],
      gateNavItems: [
        { href: "/gates/", label: "All Gates" },
        { href: "/gates/driveway-gates/", label: "Driveway" },
        { href: "/gates/automatic-gates/", label: "Automatic" },
        { href: "/gates/wood-gates/", label: "Wood" },
        { href: "/gates/iron-gates/", label: "Iron" },
        { href: "/gates/gate-repair/", label: "Repair" },
      ],
      deckNavItems: [],
      patioNavItems: [],
      serviceNavItems: [{ href: "/services/gate-installation/", label: "Gate Installation" }],
      toolsNavItems: [],
      areasNavItems: [{ href: "/service-areas/", label: "Service Areas" }],
      footerColumns: [
        {
          title: "Gates",
          links: [
            { href: "/gates/driveway-gates/", label: "Driveway Gates" },
            { href: "/gates/automatic-gates/", label: "Automatic" },
            { href: "/gates/gate-repair/", label: "Repair" },
          ],
        },
        {
          title: "Company",
          links: [
            { href: "https://twinriversfence.com/", label: "Twin Rivers Fence" },
            { href: "/faq/", label: "FAQ" },
            { href: "/privacy/", label: "Privacy" },
            { href: "/terms/", label: "Terms" },
          ],
        },
      ],
    };
  }
  // fencing / metro
  return {
    nav: [
      { href: "/services/", label: "Services", dropdown: "services" },
      { href: "/fence-types/", label: "Fencing", dropdown: "fencing" },
      { href: "/custom-gates/", label: "Gates" },
      { href: "/commercial-fencing/", label: "Commercial" },
      { href: "/service-areas/", label: "Areas" },
      { href: "/resources/", label: "Resources" },
      { href: "/faq/", label: "FAQ" },
      { href: "/#contact", label: "Quote" },
    ],
    fenceNavItems: [
      { href: "/fence-types/", label: "All Types" },
      { href: "/wood-fencing/", label: "Wood" },
      { href: "/vinyl-fencing/", label: "Vinyl" },
      { href: "/chain-link-fencing/", label: "Chain Link" },
      { href: "/fence-types/privacy-fence/", label: "Privacy" },
      { href: "/fence-types/pool-fence/", label: "Pool" },
    ],
    gateNavItems: [{ href: "/custom-gates/", label: "Custom Gates" }],
    deckNavItems: [],
    patioNavItems: [],
    serviceNavItems: [
      { href: "/services/", label: "All Services" },
      { href: "/services/fence-installation/", label: "Installation" },
      { href: "/fence-repair/", label: "Repair" },
      { href: "/commercial-fencing/", label: "Commercial" },
      { href: "/temporary-fence-rental/", label: "Temporary" },
    ],
    toolsNavItems: [],
    areasNavItems: [{ href: "/service-areas/", label: "Service Areas" }],
    footerColumns: [
      {
        title: "Services",
        links: [
          { href: "/services/fence-installation/", label: "Installation" },
          { href: "/fence-repair/", label: "Repair" },
          { href: "/commercial-fencing/", label: "Commercial" },
          { href: "/custom-gates/", label: "Gates" },
        ],
      },
      {
        title: "Company",
        links: [
          { href: "https://twinriversfence.com/", label: "Twin Rivers Fence" },
          ...(cfg.focus === "metro" ? [{ href: "/city-sites/", label: "City Sites" }] : []),
          { href: "/faq/", label: "FAQ" },
          { href: "/privacy/", label: "Privacy" },
          { href: "/terms/", label: "Terms" },
        ],
      },
    ],
  };
}

function writeSiteJs(dest, cfg) {
  const nav = buildNav(cfg);
  const host = cfg.domain.replace(/^https?:\/\//, "");
  const content = `/** Shared business & site configuration — Twin Rivers Fence */
export const site = {
  name: ${JSON.stringify(SHARED.name)},
  localName: ${JSON.stringify(cfg.localName)},
  domain: ${JSON.stringify(cfg.domain)},
  phoneDisplay: ${JSON.stringify(SHARED.phoneDisplay)},
  phoneTel: ${JSON.stringify(SHARED.phoneTel)},
  license: ${JSON.stringify(SHARED.license)},
  email: null,
  yearsExperience: ${SHARED.yearsExperience},
  priceRange: ${JSON.stringify(SHARED.priceRange)},
  parentUrl: ${JSON.stringify(SHARED.parentUrl)},
  googleReviewsUrl: ${JSON.stringify(SHARED.googleReviewsUrl)},
  googleMapsUrl: ${JSON.stringify(SHARED.googleMapsUrl)},
  hours: ${JSON.stringify(SHARED.hours)},
  trustLocality: ${JSON.stringify(cfg.trustLocality)},
  schemaTypes: ${JSON.stringify(cfg.schemaTypes)},
  address: ${JSON.stringify(cfg.address)},
  geo: ${JSON.stringify(cfg.geo)},
  areaServed: ${JSON.stringify(cfg.areaServed)},
  socialSameAs: [
    ${JSON.stringify(SHARED.googleReviewsUrl)},
    ${JSON.stringify(SHARED.parentUrl)},
  ],
  ogImage: ${JSON.stringify(cfg.domain + "/favicon-512x512.png")},
  themeColor: ${JSON.stringify(cfg.theme.paper)},
  turnstileSiteKey: String(process.env.TURNSTILE_SITE_KEY || "").trim(),
  schemaDescription: ${JSON.stringify(cfg.schemaDescription)},
  focus: ${JSON.stringify(cfg.focus)},
};

export const fenceNavItems = ${JSON.stringify(nav.fenceNavItems, null, 2)};
export const gateNavItems = ${JSON.stringify(nav.gateNavItems, null, 2)};
export const deckNavItems = ${JSON.stringify(nav.deckNavItems, null, 2)};
export const patioNavItems = ${JSON.stringify(nav.patioNavItems, null, 2)};
export const serviceNavItems = ${JSON.stringify(nav.serviceNavItems, null, 2)};
export const areasNavItems = ${JSON.stringify(nav.areasNavItems, null, 2)};
export const toolsNavItems = ${JSON.stringify(nav.toolsNavItems, null, 2)};
export const nav = ${JSON.stringify(nav.nav, null, 2)};
export const footerColumns = ${JSON.stringify(nav.footerColumns, null, 2)};
export const networkLinks = ${JSON.stringify(NETWORK_LINKS, null, 2)};
`;
  fs.writeFileSync(path.join(dest, "src/data/site.js"), content);
}

function writePagesJs(dest, siteKey, cfg) {
  const pages = buildPages(siteKey, cfg);
  fs.writeFileSync(
    path.join(dest, "src/data/pages.js"),
    `/** Generated page corpus for ${cfg.localName} */\nexport const pages = ${JSON.stringify(pages, null, 2)};\n`
  );
}

function writeCalculatorsJs(dest, cfg) {
  // Keep empty calculator set for specialty clarity — quote CTA is enough; avoids unused GB tools.
  fs.writeFileSync(
    path.join(dest, "src/data/calculators.js"),
    `/** Calculators disabled on this specialty/city site — use contact quote flow. */\nexport const calculatorPages = [];\n`
  );
}

function writeHomeJs(dest, cfg) {
  const h = cfg.home;
  const networkBlock = h.cityNetworkNote
    ? `
  <section class="dark-section alt hub-preview">
    <h2 class="section-heading">Need a different Twin Rivers city?</h2>
    <p class="sub-text">This site focuses on Sacramento city &amp; commercial work. Use a dedicated city site when that market fits better.</p>
    <div class="hub-grid">
      <article class="hub-card"><h3><a href="https://rosevillefencingca.com/">Roseville</a></h3><p>Dedicated Roseville fencing site.</p></article>
      <article class="hub-card"><h3><a href="https://rocklinfencing.com/">Rocklin</a></h3><p>Dedicated Rocklin fencing site.</p></article>
      <article class="hub-card"><h3><a href="https://folsomfencing.com/">Folsom</a></h3><p>Dedicated Folsom fencing site.</p></article>
      <article class="hub-card"><h3><a href="/city-sites/">All city sites</a></h3><p>Full Twin Rivers city network directory.</p></article>
    </div>
  </section>`
    : "";

  const photos = h.photoSections
    .map(
      (s, i) => `
  <section class="photo-section${s.side === "right" ? " overlay-right" : ""}" id="${s.id}">
    <img class="photo-bg" src="${s.img}" alt="${s.alt}" width="1600" height="900" loading="${i === 0 ? "eager" : "lazy"}" decoding="async"${i === 0 ? ' fetchpriority="high"' : ""}>
    <div class="photo-content ${s.side}"><span class="section-tag">${s.tag}</span><h2>${s.h2}</h2><p>${s.p}</p></div>
  </section>`
    )
    .join("\n");

  const services = h.services
    .map(
      (s) =>
        `<article class="service-card"><h3><a href="${s.href}">${s.title}</a></h3><p>${s.blurb}</p></article>`
    )
    .join("\n    ");

  const areas = h.areas.map((a) => `<span class="city-tag">${a}</span>`).join("\n    ");

  const content = `import { site } from "../data/site.js";
import { escapeHtml, faqSchema, renderLayout, riverContactSection } from "./layout.js";

const homeFaqs = ${JSON.stringify(h.faqs, null, 2)};

export function renderHomePage() {
  const body = \`
  <section id="hero">
    <canvas id="hero-canvas" aria-hidden="true"></canvas>
    <div class="hero-inner">
      <p class="eyebrow">${h.eyebrow}</p>
      <h1>${h.h1}</h1>
      <p class="sub">${h.sub}</p>
      <p class="sub" style="margin-top:0.5rem">Hours: \${escapeHtml(site.hours)}</p>
      <a href="#contact" class="btn-gold">Get a Free Estimate</a>
      <a href="tel:\${site.phoneTel}" class="btn-gold" style="margin-left:0.75rem;background:transparent;border:1px solid rgba(255,255,255,0.45)">Call \${escapeHtml(site.phoneDisplay)}</a>
      <div class="google-trust-bar" aria-label="Twin Rivers Fence trust signals">
        <a class="google-review-link" href="\${site.googleReviewsUrl}" target="_blank" rel="noopener noreferrer"><span class="google-star-row" aria-label="Reviews on Google">Google reviews</span> — Twin Rivers Fence</a>
        <span>Licensed &amp; Insured — #\${site.license}</span>
        <span>\${escapeHtml(site.hours)}</span>
      </div>
    </div>
    <div class="scroll-cue" aria-hidden="true"><span>Scroll</span><div class="scroll-line"></div></div>
  </section>

  ${photos}

  <section class="dark-section who">
    <div class="who-grid">
      <div class="who-copy">
        <h2>${h.whoHeading}</h2>
        ${h.whoBody.map((p) => `<p>${p}</p>`).join("")}
        <p>Services on this site are provided by <a href="https://twinriversfence.com/">Twin Rivers Fence</a>.</p>
        <p class="license">Licensed Contractor #\${site.license} — \${escapeHtml(site.address.locality)}, CA</p>
      </div>
      <div class="stats" aria-label="Trust signals">
        <div class="stat-card"><div class="stat-number">✓</div><div class="stat-label">Licensed #\${site.license}</div></div>
        <div class="stat-card"><div class="stat-number">✓</div><div class="stat-label">Insured</div></div>
        <div class="stat-card"><div class="stat-number">G</div><div class="stat-label"><a href="\${site.googleReviewsUrl}" target="_blank" rel="noopener noreferrer">Google Business Profile</a></div></div>
      </div>
    </div>
  </section>

  <section class="dark-section services">
  <h2 class="section-heading">Services</h2>
  <div class="services-grid">
    ${services}
  </div>
  </section>

  ${networkBlock}

  <section class="dark-section alt areas">
    <h2>Areas we serve</h2>
    <p class="sub-text">Local focus — not generic filler</p>
    <div class="tag-cloud" aria-label="Service areas">
    ${areas}
    </div>
  </section>

  <section class="dark-section alt faq-section" id="home-faq">
    <h2 class="section-heading">Frequently asked questions</h2>
    <div class="faq-list">
      \${homeFaqs
        .map(
          (f) => \`
      <details class="faq-item">
        <summary>\${escapeHtml(f.question)}</summary>
        <p>\${escapeHtml(f.answer)}</p>
      </details>\`
        )
        .join("")}
    </div>
  </section>

  \${riverContactSection({
    heading: "Get a free estimate",
    note: "Tell us about your project — we will give you a straight answer. Or call " + site.phoneDisplay + ".",
  })}
\`;

  return renderLayout({
    title: ${JSON.stringify(
      cfg.focus === "decks"
        ? `${cfg.localName} | Free Estimates | License #${SHARED.license}`
        : cfg.focus === "gates"
          ? `${cfg.localName} | Free Estimates | License #${SHARED.license}`
          : `${cfg.localName} | Free Estimates | License #${SHARED.license}`
    )},
    description: ${JSON.stringify(cfg.schemaDescription)},
    path: "/",
    body,
    schemaExtra: [faqSchema(homeFaqs)],
  });
}
`;
  fs.writeFileSync(path.join(dest, "src/templates/home.js"), content);
}

function patchLayout(dest, cfg) {
  let layout = fs.readFileSync(path.join(dest, "src/templates/layout.js"), "utf8");
  // Replace hardcoded citySites list with networkLinks from site.js
  layout = layout.replace(
    /import \{ site, nav, fenceNavItems, gateNavItems, deckNavItems, patioNavItems, serviceNavItems, toolsNavItems, footerColumns \} from "\.\.\/data\/site\.js";/,
    `import { site, nav, fenceNavItems, gateNavItems, deckNavItems, patioNavItems, serviceNavItems, toolsNavItems, footerColumns, networkLinks } from "../data/site.js";`
  );
  layout = layout.replace(
    /const citySites = \[[\s\S]*?\];/,
    `const citySites = networkLinks;`
  );
  // Fix schema types
  layout = layout.replace(
    `"@type": ["HomeAndConstructionBusiness", "FenceContractor"]`,
    `"@type": site.schemaTypes || ["HomeAndConstructionBusiness", "FenceContractor"]`
  );
  // Fix trust strip Nevada County in page.js separately
  fs.writeFileSync(path.join(dest, "src/templates/layout.js"), layout);

  let pageT = fs.readFileSync(path.join(dest, "src/templates/page.js"), "utf8");
  pageT = pageT.replace(
    `<span>Nevada County Local</span>`,
    `<span>\${escapeHtml(site.trustLocality || "Northern California")}</span>`
  );
  pageT = pageT.replace(
    /note: note \|\| "Tell us about your Nevada County fence project[^"]*"/,
    `note: note || ("Tell us about your project in " + site.address.locality + " — we will give you a straight answer and a real quote.")`
  );
  fs.writeFileSync(path.join(dest, "src/templates/page.js"), pageT);
}

function writeThemeCss(dest, cfg) {
  const css = `
:root {
  --trf-accent: ${cfg.theme.accent};
  --trf-accent-2: ${cfg.theme.accent2};
  --trf-ink: ${cfg.theme.ink};
  --trf-paper: ${cfg.theme.paper};
}
#hero {
  background: ${cfg.theme.heroGrad} !important;
}
.btn-gold,
a.btn-gold {
  background: var(--trf-accent-2) !important;
  color: #111 !important;
}
.section-tag {
  color: var(--trf-accent-2) !important;
}
.stat-number,
.license {
  color: var(--trf-accent-2) !important;
}
`;
  fs.appendFileSync(path.join(dest, "src/styles/site.css"), css);
}

function writeNetlifyToml(dest, cfg) {
  const host = cfg.domain.replace(/^https?:\/\//, "");
  const content = `[build]
  command = "node build.mjs"
  publish = "dist"
  [build.environment]
    NODE_VERSION = "20"

[[edge_functions]]
  path = "/*"
  function = "block-forms"

[[redirects]]
  from = "/privacy"
  to = "/privacy/"
  status = 301

[[redirects]]
  from = "/terms"
  to = "/terms/"
  status = 301

[[redirects]]
  from = "/success"
  to = "/success/"
  status = 301

[[headers]]
  for = "/*"
  [headers.values]
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    X-Frame-Options = "SAMEORIGIN"

[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"
`;
  fs.writeFileSync(path.join(dest, "netlify.toml"), content);
}

function writeContactLead(dest) {
  let src = fs.readFileSync(path.join(SCAFFOLD, "netlify/functions/contact-lead.cjs"), "utf8");
  const list = NEW_DOMAINS.map((d) => `  "${d}",`).join("\n");
  src = src.replace(
    /const ALLOWED_HOSTS = new Set\(\[[\s\S]*?\]\);/,
    `const ALLOWED_HOSTS = new Set([\n${list}\n]);`
  );
  fs.writeFileSync(path.join(dest, "netlify/functions/contact-lead.cjs"), src);
}

function writeBuildMjs(dest, cfg) {
  let build = fs.readFileSync(path.join(SCAFFOLD, "build.mjs"), "utf8");
  build = build.replace(/Granite Bay Fence Company/g, cfg.localName);
  build = build.replace(/granitebayfencing\.com/g, cfg.domain.replace(/^https?:\/\//, ""));
  build = build.replace(
    /const redirectedToHome = new Set\(\["\/service-areas\/granite-bay\/"\]\);/,
    `const redirectedToHome = new Set([]);`
  );
  // Soften success copy
  build = build.replace(/fence project details/g, "project details");
  fs.writeFileSync(path.join(dest, "build.mjs"), build);
}

function writeReadme(dest, cfg) {
  const host = cfg.domain.replace(/^https?:\/\//, "");
  const content = `# ${cfg.localName}

Static marketing site for **Twin Rivers Fence** — ${cfg.focus} focus.

- **Domain (planned):** ${cfg.domain}
- **Business:** Twin Rivers Fence
- **Phone:** ${SHARED.phoneDisplay}
- **License:** #${SHARED.license}
- **Hours:** ${SHARED.hours}
- **Parent:** ${SHARED.parentUrl}

## Stack

- Custom Node static site generator (\`build.mjs\`)
- Netlify publish directory: \`dist\`
- Lead form → \`/.netlify/functions/contact-lead\` → hub \`lead-ingest\` on twinriversfence.com

## Commands

\`\`\`bash
npm run build
npm start   # serves dist on :4173
\`\`\`

## Netlify settings (owner will configure)

| Setting | Value |
|---|---|
| Build command | \`node build.mjs\` |
| Publish directory | \`dist\` |
| Node version | \`20\` |

### Environment variables (names only)

| Name | Purpose |
|---|---|
| \`TURNSTILE_SITE_KEY\` | Cloudflare Turnstile site key (public) |
| \`TURNSTILE_SECRET_KEY\` | Used on hub ingest if configured there |
| \`LEAD_FAIL_OPEN_WEBHOOK\` | Optional fail-open alert webhook |
| \`URL\` / \`DEPLOY_PRIME_URL\` | Provided by Netlify at runtime |

## Owner actions required after deploy

1. Create Netlify site and connect GitHub repo (do not done by this agent).
2. Point Cloudflare DNS for \`${host}\` to Netlify.
3. **Update hub allowlist** on \`twinriversfence.com\` \`lead-ingest\` to include \`${host}\` (required for lead delivery).
4. Add Search Console / analytics when ready — not configured here.
5. Do not submit for indexing until content review is complete.

${cfg.doorwayNote ? `## Doorway / duplicate-content note\n\n${cfg.doorwayNote}\n` : ""}
${cfg.capabilityNote ? `## Capability note\n\n${cfg.capabilityNote}\n` : ""}

## Verified claims only

This site does not invent street addresses, review counts, awards, or project totals.
`;
  fs.writeFileSync(path.join(dest, "README.md"), content);
}

function writePackageJson(dest, cfg) {
  fs.writeFileSync(
    path.join(dest, "package.json"),
    JSON.stringify(
      {
        name: cfg.repo,
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: {
          build: "node build.mjs",
          start: "npx --yes serve dist -p 4173",
        },
      },
      null,
      2
    ) + "\n"
  );
}

function writeGitignore(dest) {
  fs.writeFileSync(dest + "/.gitignore", "node_modules/\ndist/\n.tools/\n_legacy/\n*.zip\n.DS_Store\n.env\n.env.*\n!.env.example\n");
}

function writeEnvExample(dest) {
  fs.writeFileSync(
    path.join(dest, ".env.example"),
    `# Public Turnstile site key (safe for build-time injection into HTML)
TURNSTILE_SITE_KEY=

# Optional — usually set in Netlify UI, not committed
LEAD_FAIL_OPEN_WEBHOOK=
`
  );
}

function writeNetlifyReady(dest, cfg) {
  fs.writeFileSync(
    path.join(dest, "NETLIFY_READY.md"),
    `# Netlify readiness — ${cfg.localName}

| Item | Value |
|---|---|
| GitHub repository | https://github.com/Lordsleezy/${cfg.repo} |
| Framework | Custom Node static generator |
| Build command | \`node build.mjs\` |
| Publish directory | \`dist\` |
| Node version | 20 |
| Edge functions | \`block-forms\` on \`/*\` |
| Functions | \`contact-lead\`, \`google-reviews\` |
| Required env | \`TURNSTILE_SITE_KEY\` (recommended) |
| Optional env | \`LEAD_FAIL_OPEN_WEBHOOK\` |
| Ready for deploy | YES — after Netlify site + DNS + hub allowlist update |

**Not done by agent:** Netlify project creation, Cloudflare DNS, indexing.
`
  );
}

function generateOne(siteKey, cfg) {
  const dest = path.join(OUT_ROOT, cfg.repo);
  console.log("Generating", cfg.repo);
  rmrf(dest);
  copyDir(SCAFFOLD, dest);
  // Remove root duplicate favicons if public has them — keep public/
  for (const f of fs.readdirSync(dest)) {
    if (f.startsWith("favicon") || f.startsWith("android-chrome") || f.startsWith("apple-touch")) {
      fs.unlinkSync(path.join(dest, f));
    }
  }
  // Remove unused generator scripts that reference GB pages-data
  rmrf(path.join(dest, "scripts"));

  writePackageJson(dest, cfg);
  writeGitignore(dest);
  writeEnvExample(dest);
  writeSiteJs(dest, cfg);
  writePagesJs(dest, siteKey, cfg);
  writeCalculatorsJs(dest, cfg);
  writeHomeJs(dest, cfg);
  patchLayout(dest, cfg);
  writeThemeCss(dest, cfg);
  writeNetlifyToml(dest, cfg);
  writeContactLead(dest);
  writeBuildMjs(dest, cfg);
  writeReadme(dest, cfg);
  writeNetlifyReady(dest, cfg);

  // Init git
  execSync("git init -b main", { cwd: dest, stdio: "pipe" });
  execSync("git add -A", { cwd: dest, stdio: "pipe" });
  execSync(
    `git -c user.name='Twin Rivers Agent' -c user.email='agent@twinrivers.local' commit -m "Initial ${cfg.localName} site from Twin Rivers scaffold"`,
    { cwd: dest, stdio: "pipe" }
  );

  // Build
  execSync("node build.mjs", { cwd: dest, stdio: "inherit" });
  return dest;
}

function main() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const results = [];
  for (const [key, cfg] of Object.entries(SITES)) {
    const dest = generateOne(key, cfg);
    const sitemap = fs.readFileSync(path.join(dest, "dist/sitemap.xml"), "utf8");
    const urls = (sitemap.match(/<loc>/g) || []).length;
    results.push({ repo: cfg.repo, domain: cfg.domain, urls, dest, doorwayNote: cfg.doorwayNote });
  }
  fs.writeFileSync(path.join(__dirname, "GENERATION_SUMMARY.json"), JSON.stringify(results, null, 2));
  console.log("\nDone:", results);
}

main();
