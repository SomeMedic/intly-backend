import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { ArcConnector } = require('../src/modules/sources/connectors/arc.connector.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

// Native identity/cardinality fields plus two full job projections, observed anonymously on 2026-10-06.
// Full raw HTML/HTTP receipts are archived in .local/reports/source-arc-native-20261006.
// Wrappers and other detail identities below are synthetic protocol variants, not live catalog coverage proof.
const fixture = {
  "buildId": "ZjB5YOjGnUm1WxOt3jXyE",
  "listing": {
    "arcJobs": [
      {
        "randomKey": "ppe7qpiw2f",
        "title": "Senior Python/Django Backend Engineer (Health Tech / Lead Technical Owner) WW-FT",
        "jobType": "contract",
        "jobRole": "engineering",
        "requiredCountries": [],
        "timeZone": null,
        "timeZoneOffset": null,
        "clientTimeZoneRestriction": null,
        "minAnnualSalary": null,
        "maxAnnualSalary": null,
        "minHourlyRate": 35,
        "maxHourlyRate": 55,
        "experienceLevel": "senior",
        "urlString": "senior-python-django-backend-engineer-health-tech-lead-technical-owner-ww-ft",
        "postedAt": 1791215571,
        "categories": [
          {
            "name": "Python",
            "urlString": "python"
          },
          {
            "name": "Django",
            "urlString": "django"
          },
          {
            "name": "Framework",
            "urlString": "framework"
          },
          {
            "name": "CI/CD",
            "urlString": "ci-cd"
          }
        ],
        "company": {
          "randomKey": "pnl8wqgd9z"
        }
      },
      {
        "randomKey": "pp7j44r1f8",
        "title": "Rust Code Reviewer (Security & Architecture) - PT - Worldwide",
        "jobType": "contract",
        "urlString": "rust-code-reviewer-security-architecture-pt-worldwide",
        "postedAt": 1791151631
      },
      {
        "randomKey": "por0f1qcs2",
        "title": "Intermediate Gis / Web-3D Developer",
        "jobType": "contract",
        "urlString": "intermediate-gis-web-3d-developer",
        "postedAt": 1790993608
      },
      {
        "randomKey": "poqyqpwawg",
        "title": "Junior GIS / Web-3D Developer",
        "jobType": "contract",
        "urlString": "junior-gis-web-3d-developer",
        "postedAt": 1790993163
      },
      {
        "randomKey": "pomzbas2gs",
        "title": "Growth Product Manager (Retention & Activation) - PT - APAC/EMEA",
        "jobType": "contract",
        "urlString": "growth-product-manager-retention-activation-pt-apac-emea",
        "postedAt": 1790955051
      },
      {
        "randomKey": "pomihw17k7",
        "title": "Machine Learning Engineer (LLM Fine-Tuning & Inference) - FT - EMEA/APAC",
        "jobType": "contract",
        "urlString": "machine-learning-engineer-llm-fine-tuning-inference-ft-emea-apac",
        "postedAt": 1790950583
      },
      {
        "randomKey": "pojy4z0sb1",
        "title": "Workflow Automation Engineer (Google Workspace + AI) - PT - APAC",
        "jobType": "contract",
        "urlString": "workflow-automation-engineer-google-workspace-ai-pt-apac",
        "postedAt": 1790926041
      },
      {
        "randomKey": "pod4839awq",
        "title": "Automation & Growth Engineer - Part-time - Worldwide ",
        "jobType": "contract",
        "urlString": "automation-growth-engineer-part-time-worldwide",
        "postedAt": 1790860697
      },
      {
        "randomKey": "po425rw8l2",
        "title": "Senior Full Stack Engineer (Next.js, PostgreSQL) - Part-time - Overlap EST",
        "jobType": "contract",
        "urlString": "senior-full-stack-engineer-next-js-postgresql-part-time-overlap-est",
        "postedAt": 1790774055
      },
      {
        "randomKey": "pnx53eqgz1",
        "title": "Cross-Platform Application Developer - Part-time - Worldwide",
        "jobType": "contract",
        "urlString": "cross-platform-application-developer-part-time-worldwide",
        "postedAt": 1790707873
      },
      {
        "randomKey": "pnvtr1kekg",
        "title": "Senior Frontend Developer (Bitcoin Lightning Wallet) - PT - WW",
        "jobType": "contract",
        "urlString": "senior-frontend-developer-bitcoin-lightning-wallet-pt-ww",
        "postedAt": 1790695293
      },
      {
        "randomKey": "pnv5a7heba",
        "title": "Senior E-Commerce & Sage X3 Integration Developer - PT/FT - NA/LATAM",
        "jobType": "contract",
        "urlString": "senior-e-commerce-sage-x3-integration-developer-pt-ft-na-latam",
        "postedAt": 1790688791
      },
      {
        "randomKey": "pnnngf2art",
        "title": "Senior Software Engineer, Platform",
        "jobType": "contract",
        "urlString": "senior-software-engineer-platform",
        "postedAt": 1790617093
      },
      {
        "randomKey": "pnnmzoujgl",
        "title": "Senior Data Engineer",
        "jobType": "contract",
        "urlString": "senior-data-engineer",
        "postedAt": 1790616969
      },
      {
        "randomKey": "pnngcchreu",
        "title": "iOS/Android Bluetooth (BLE, iOS, Android) - PT - WW",
        "jobType": "contract",
        "urlString": "ios-android-bluetooth-ble-ios-android-pt-ww",
        "postedAt": 1790615202
      },
      {
        "randomKey": "pnbwza8npq",
        "title": "Remote - Software Developer",
        "jobType": "permanent",
        "urlString": "remote-software-developer",
        "postedAt": 1790504832
      },
      {
        "randomKey": "pmydlacrep",
        "title": "Senior GIS / Web-3D Developer",
        "jobType": "contract",
        "urlString": "senior-gis-web-3d-developer",
        "postedAt": 1790375323
      },
      {
        "randomKey": "pmpz8dsasz",
        "title": "Linux DevOps & Backend Engineer",
        "jobType": "contract",
        "urlString": "linux-devops-backend-engineer",
        "postedAt": 1790294980
      },
      {
        "randomKey": "pmk6tff30h",
        "title": "Backend Engineer (Java/Spring Boot, AWS, EKS, Kubernetes) - FT - NA/LATAM (2)",
        "jobType": "contract",
        "urlString": "backend-engineer-java-spring-boot-aws-eks-kubernetes-ft-na-latam-2",
        "postedAt": 1790239600
      },
      {
        "randomKey": "pmfeb6c6yo",
        "title": "Senior Quant Developer – Trading Systems (FT-WW)",
        "jobType": "contract",
        "urlString": "senior-quant-developer-trading-systems-ft-ww",
        "postedAt": 1790193761
      },
      {
        "randomKey": "plyvd3koy1",
        "title": "Ecommerce Website Developer - PT - Worldwide",
        "jobType": "contract",
        "urlString": "ecommerce-website-developer-pt-worldwide",
        "postedAt": 1790035672
      },
      {
        "randomKey": "plxlgjqi31",
        "title": "    Fractional CTO / Senior Software Architect – Multi-Location E-Commerce & SaaS",
        "jobType": "contract",
        "urlString": "fractional-cto-senior-software-architect-multi-location-e-commerce-saas",
        "postedAt": 1790023474
      },
      {
        "randomKey": "plvko6f9cd",
        "title": "Senior / Staff Software Engineer (.Net, Azure) - Perm - India",
        "jobType": "permanent",
        "urlString": "senior-staff-software-engineer-net-azure-perm-india",
        "postedAt": 1790004133
      },
      {
        "randomKey": "plv9d3m3hc",
        "title": "Senior Full-Stack Developer (Laravel, Javascript, AWS, AI) - Full Time - Overlap with EST (4h)",
        "jobType": "contract",
        "urlString": "senior-full-stack-developer-laravel-javascript-aws-ai-full-time-overlap-with-est-4h",
        "postedAt": 1790001128
      },
      {
        "randomKey": "pkuq20uor8",
        "title": "App Developer for Women's Health",
        "jobType": "contract",
        "urlString": "app-developer-for-women-s-health",
        "postedAt": 1789651624
      },
      {
        "randomKey": "pku5rt1zn0",
        "title": "Mobile developer (Flutter, Supabase) - Fulltime - Worldwide",
        "jobType": "contract",
        "urlString": "mobile-developer-flutter-supabase-fulltime-worldwide",
        "postedAt": 1789646234
      },
      {
        "randomKey": "pkod33sgbk",
        "title": "Staff Technical Account Manager - Remote - US Only",
        "jobType": "permanent",
        "urlString": "staff-technical-account-manager-remote-us-only",
        "postedAt": 1789590782
      },
      {
        "randomKey": "pkmiiyi85w",
        "title": "Senior Full-Stack Developer",
        "jobType": "permanent",
        "urlString": "senior-full-stack-developer",
        "postedAt": 1789573095
      },
      {
        "randomKey": "pkkpqzmbsn",
        "title": "Senior Creative Strategist - PT - Worldwide",
        "jobType": "contract",
        "urlString": "senior-creative-strategist-pt-worldwide",
        "postedAt": 1789555883
      },
      {
        "randomKey": "pkklee26k6",
        "title": "Senior Tracking & Attribution Lead - PT - Worldwide",
        "jobType": "contract",
        "urlString": "senior-tracking-attribution-lead-pt-worldwide",
        "postedAt": 1789554727
      }
    ],
    "externalJobs": [
      {
        "randomKey": "o9ahbnwkgx",
        "title": "Senior Design Program Manager II",
        "jobType": "permanent",
        "requiredCountries": [
          "US",
          "CA",
          "DE",
          "ME",
          "MA",
          "MD",
          "PA",
          "VA",
          "CO",
          "IL"
        ],
        "experienceLevels": [
          "manager",
          "senior"
        ],
        "urlString": "instacart-senior-design-program-manager-ii",
        "postedAt": 1791216344,
        "categories": [
          {
            "name": "Automation",
            "urlString": "automation"
          },
          {
            "name": "Figma",
            "urlString": "figma"
          },
          {
            "name": "AI",
            "urlString": "ai"
          },
          {
            "name": "Operations",
            "urlString": "operations"
          },
          {
            "name": "Wireframing/prototyping",
            "urlString": "wireframing-prototyping"
          },
          {
            "name": "Program Management",
            "urlString": "program-management"
          },
          {
            "name": "Community management",
            "urlString": "community-management"
          },
          {
            "name": "Marketing strategies",
            "urlString": "marketing-strategies"
          },
          {
            "name": "Infrastructure",
            "urlString": "infrastructure"
          },
          {
            "name": "Team collaboration",
            "urlString": "team-collaboration"
          },
          {
            "name": "Project documentation",
            "urlString": "project-documentation"
          },
          {
            "name": "Product design",
            "urlString": "product-design"
          },
          {
            "name": "Embedded Systems",
            "urlString": "embedded-systems"
          },
          {
            "name": "Design Systems",
            "urlString": "design-systems"
          },
          {
            "name": "Security software",
            "urlString": "security-software"
          },
          {
            "name": "Communications",
            "urlString": "communications"
          },
          {
            "name": "Compliance",
            "urlString": "compliance"
          },
          {
            "name": "Software Development",
            "urlString": "software-development"
          },
          {
            "name": "Vendor management",
            "urlString": "vendor-management"
          },
          {
            "name": "Growth",
            "urlString": "growth"
          },
          {
            "name": "Roadmap planning",
            "urlString": "roadmap-planning"
          },
          {
            "name": "Data",
            "urlString": "data"
          },
          {
            "name": "Storytelling",
            "urlString": "storytelling"
          },
          {
            "name": "System security",
            "urlString": "system-security"
          },
          {
            "name": "Jira",
            "urlString": "jira"
          },
          {
            "name": "Design thinking",
            "urlString": "design-thinking"
          },
          {
            "name": "Stakeholder management",
            "urlString": "stakeholder-management"
          },
          {
            "name": "Tooling",
            "urlString": "tooling"
          },
          {
            "name": "Advance prototyping",
            "urlString": "advance-prototyping"
          },
          {
            "name": "Multi platform",
            "urlString": "multi-platform"
          },
          {
            "name": "Component libraries",
            "urlString": "component-libraries"
          },
          {
            "name": "Tokenization",
            "urlString": "tokenization"
          },
          {
            "name": "Resource management",
            "urlString": "resource-management"
          }
        ],
        "company": {
          "name": "Instacart",
          "randomKey": "alug36y5gh"
        }
      },
      {
        "randomKey": "pplcub3boy",
        "title": "Leather Material Developer",
        "jobType": "permanent",
        "urlString": "quince-leather-material-developer",
        "postedAt": 1791216338
      },
      {
        "randomKey": "pplcub40z5",
        "title": "Engineering Product Manager (Remote)",
        "jobType": "permanent",
        "urlString": "cisco-engineering-product-manager-remote",
        "postedAt": 1791216334
      },
      {
        "randomKey": "ppliy4v0zh",
        "title": "Senior Marketing analyst",
        "jobType": "permanent",
        "urlString": "jobgether-senior-marketing-analyst",
        "postedAt": 1791216315
      },
      {
        "randomKey": "ppliysh77t",
        "title": "Senior Director, Marketing - Germline Portfolio",
        "jobType": "permanent",
        "urlString": "tempus-ai-senior-director-marketing-germline-portfolio",
        "postedAt": 1791216311
      },
      {
        "randomKey": "pma4dnopa1",
        "title": "Influencer marketing",
        "jobType": "permanent",
        "urlString": "founders-arm-influencer-marketing",
        "postedAt": 1791216310
      },
      {
        "randomKey": "pplizx4ong",
        "title": "Brand Marketing Manager",
        "jobType": "permanent",
        "urlString": "wiraa-brand-marketing-manager",
        "postedAt": 1791216310
      },
      {
        "randomKey": "pplj0f83il",
        "title": "Amazon Marketing Specialist || WFH",
        "jobType": "permanent",
        "urlString": "career-at-callmax-solutions-philippines-amazon-marketing-specialist-wfh",
        "postedAt": 1791216310
      },
      {
        "randomKey": "pma07jf7kc",
        "title": "Marketing Operations Manager",
        "jobType": "permanent",
        "urlString": "talenthop-marketing-operations-manager",
        "postedAt": 1791216309
      },
      {
        "randomKey": "pplj121arz",
        "title": "Marketing and Professional Education Specialist  BDI Surgery, Other Eastern Europe & Israel",
        "jobType": "permanent",
        "urlString": "bd-marketing-and-professional-education-specialist-bdi-surgery-other-eastern-europe-israel",
        "postedAt": 1791216309
      },
      {
        "randomKey": "p3hy417tni",
        "title": "Senior Marketing & Ops Strategy Analyst",
        "jobType": "permanent",
        "urlString": "risepoint-senior-marketing-ops-strategy-analyst",
        "postedAt": 1791216308
      },
      {
        "randomKey": "pplj2d3bo3",
        "title": "Manager, Field Marketing",
        "jobType": "permanent",
        "urlString": "premium-service-brands-manager-field-marketing",
        "postedAt": 1791216308
      },
      {
        "randomKey": "pplj2x1gid",
        "title": "Lead Marketing Analyst",
        "jobType": "permanent",
        "urlString": "social-discovery-group-lead-marketing-analyst",
        "postedAt": 1791216308
      },
      {
        "randomKey": "pfuev136he",
        "title": "Channel Marketing Manager - North America",
        "jobType": "permanent",
        "urlString": "traild-channel-marketing-manager-north-america",
        "postedAt": 1791216307
      },
      {
        "randomKey": "pmw8xfqyau",
        "title": "Marketing Manager",
        "jobType": "permanent",
        "urlString": "forte-renewables-marketing-manager",
        "postedAt": 1791216307
      },
      {
        "randomKey": "pplj4p0kwo",
        "title": "Head of Communications, Public Relations & Analyst Relations Marketing",
        "jobType": "permanent",
        "urlString": "tenex-ai-head-of-communications-public-relations-analyst-relations-marketing",
        "postedAt": 1791216307
      },
      {
        "randomKey": "pplj4p0xjt",
        "title": "Vice President, Revenue Marketing",
        "jobType": "permanent",
        "urlString": "billtrust-vice-president-revenue-marketing",
        "postedAt": 1791216307
      },
      {
        "randomKey": "pplj5avjkq",
        "title": "Senior Product Marketing Manager, Risk Advisory",
        "jobType": "permanent",
        "urlString": "fieldguide-senior-product-marketing-manager-risk-advisory",
        "postedAt": 1791216306
      },
      {
        "randomKey": "pplj5x5fj1",
        "title": "Senior Product Marketing Manager",
        "jobType": "permanent",
        "urlString": "quera-computing-inc-senior-product-marketing-manager",
        "postedAt": 1791216306
      },
      {
        "randomKey": "pplj6jpof5",
        "title": "Marketing Manager - Fuze Services",
        "jobType": "permanent",
        "urlString": "fuze-health-marketing-manager-fuze-services",
        "postedAt": 1791216305
      },
      {
        "randomKey": "lz2ve3y6s8",
        "title": "Digital Marketing Strategist",
        "jobType": "contract",
        "urlString": "runner-agency-digital-marketing-strategist",
        "postedAt": 1791216304
      },
      {
        "randomKey": "p3hv48db7d",
        "title": "Marketing - Manager, Paid Media and Activation",
        "jobType": "permanent",
        "urlString": "devry-university-marketing-manager-paid-media-and-activation",
        "postedAt": 1791216304
      },
      {
        "randomKey": "pplj8ywkpz",
        "title": "Paid Marketing/Growth Marketing Manager (f/m/x)",
        "jobType": "permanent",
        "urlString": "tourlane-paid-marketing-growth-marketing-manager-f-m-x",
        "postedAt": 1791216303
      },
      {
        "randomKey": "pplj9gudbd",
        "title": "Associate Field Marketing Manager / Manager",
        "jobType": "permanent",
        "urlString": "veeva-systems-associate-field-marketing-manager-manager",
        "postedAt": 1791216303
      },
      {
        "randomKey": "pplj3l1i3a",
        "title": "FBS - Marketing Consultant II",
        "jobType": "permanent",
        "urlString": "capgemini-fbs-marketing-consultant-ii",
        "postedAt": 1791216302
      },
      {
        "randomKey": "phqe8l9jp5",
        "title": "Senior Klaviyo Email Marketing Specialist",
        "jobType": "permanent",
        "urlString": "wallabaga-senior-klaviyo-email-marketing-specialist",
        "postedAt": 1791216302
      },
      {
        "randomKey": "ppljausv75",
        "title": "Channel Partners Marketing Manager",
        "jobType": "permanent",
        "urlString": "wellhub-channel-partners-marketing-manager",
        "postedAt": 1791216301
      },
      {
        "randomKey": "ppljbeselx",
        "title": "Marketing Executive/Director/SEO/Marketing Analyst",
        "jobType": "permanent",
        "urlString": "applab-systems-inc-marketing-executive-director-seo-marketing-analyst",
        "postedAt": 1791216300
      },
      {
        "randomKey": "ppljbp7g8m",
        "title": "Senior Marketing Communications Specialist",
        "jobType": "permanent",
        "urlString": "optum-senior-marketing-communications-specialist",
        "postedAt": 1791216300
      },
      {
        "randomKey": "ppljbpdf5j",
        "title": "Growth Marketing Manager",
        "jobType": "permanent",
        "urlString": "mckay-advertising-activation-growth-marketing-manager",
        "postedAt": 1791216300
      }
    ],
    "totalExternalJobCount": 8222
  },
  "exclusiveJob": {
    "randomKey": "ppe7qpiw2f",
    "title": "Senior Python/Django Backend Engineer (Health Tech / Lead Technical Owner) WW-FT",
    "jobType": "contract",
    "jobRole": "engineering",
    "requiredCountries": [],
    "requiredLocations": [
      "worldwide"
    ],
    "timezone": null,
    "timezoneOffset": null,
    "clientTimezoneRestriction": null,
    "minAnnualSalary": null,
    "maxAnnualSalary": null,
    "minHourlyRate": 35,
    "maxHourlyRate": 55,
    "experienceLevel": "senior",
    "urlString": "senior-python-django-backend-engineer-health-tech-lead-technical-owner-ww-ft",
    "createdAt": 1791215571,
    "updatedAt": 1791300169,
    "description": "### Role Overview\n\nJoin our innovative team as a **Senior Python/Django Backend Engineer** in the health tech space. You will play a pivotal role in transforming complex health data into actionable insights through our dual-system architecture. Our systems include a Clinic Management Platform for B2B operations and the Spectra Health & Lifestyle Engine, which processes various inputs to provide personalized health recommendations.\n\n#### Responsibilities\n\n- **System Ownership & Legacy Takeover**: Inherit and stabilize the existing backend ecosystem, ensuring robust documentation and test coverage. Modernize deployment pipelines and manage production environments without unnecessary code rewrites.\n- **Architecture & Engine Development**: Complete the development of the Spectra calculation engine, designing clean REST APIs and ensuring the logic remains independent from presentation layers.\n- **Data & Rules Engine Design**: Implement complex health algorithms and data transformations using libraries like Pandas and NumPy.\n- **Selective AI Integration**: Develop auditable AI pipelines to convert health metrics into personalized explanations while maintaining clinical accuracy.\n- **Infrastructure & Operations**: Oversee PostgreSQL schemas, manage asynchronous queues with Celery/Redis, and ensure data security and GDPR compliance.\n- **Founder Collaboration**: Serve as the primary technical advisor, translating business concepts into reliable software and creating comprehensive documentation.\n\n#### Required Skills\n\n- Strong expertise in **Python**, **Django**, **Django REST Framework**, and **PostgreSQL**.\n- Experience with **Celery** and **Redis** for managing asynchronous job queues.\n- Proficiency in inheriting and maintaining mature codebases, with experience in production deployments.\n- Skilled in data-processing pipelines and libraries such as **Pandas** and **NumPy**.\n- Hands-on experience with **Docker**, cloud environments like **Heroku/AWS**, CI/CD, and secrets management.\n- Knowledge in integrating **LLMs/APIs** into production software with data protection measures.\n\n#### Nice to Have\n\n- Background in healthcare or health-tech domains, including handling HL7 data or GDPR/HIPAA compliance.\n- Familiarity with third-party integrations such as **WooCommerce/WordPress** or **Microsoft Graph API**.\n- Basic understanding of modern frontend frameworks like **React** for API coordination, though frontend development is not required.\n",
    "closed": false,
    "state": "opened",
    "aasmState": "open",
    "availableHoursPerWeek": 40,
    "estimatedWeeks": 12,
    "jobLink": null,
    "categories": [
      {
        "name": "Python",
        "urlString": "python"
      },
      {
        "name": "Django",
        "urlString": "django"
      },
      {
        "name": "Framework",
        "urlString": "framework"
      },
      {
        "name": "CI/CD",
        "urlString": "ci-cd"
      }
    ],
    "optionalCategories": [
      {
        "name": "Healthcare industry experience",
        "urlString": "healthcare-industry-experience"
      }
    ],
    "company": null
  },
  "externalJob": {
    "randomKey": "o9ahbnwkgx",
    "title": "Senior Design Program Manager II",
    "contractType": "permanent",
    "requiredCountries": [
      "US",
      "CA",
      "DE",
      "ME",
      "MA",
      "MD",
      "PA",
      "VA",
      "CO",
      "IL"
    ],
    "experienceLevels": [
      "manager",
      "senior"
    ],
    "urlString": "instacart-senior-design-program-manager-ii",
    "postedAt": 1791216344,
    "description": "<strong>We're transforming the grocery industry  \n  \n</strong>At Instacart, we invite the world to share love through food because we believe everyone should have access to the food they love and more time to enjoy it together. Where others see a simple need for grocery delivery, we see exciting complexity and endless opportunity to serve the varied needs of our community. We work to deliver an essential service that customers rely on to get their groceries and household goods, while also offering safe and flexible earnings opportunities to Instacart Personal Shoppers.  \n  \nInstacart has become a lifeline for millions of people, and we’re building the team to help push our shopping cart forward. If you’re ready to do the best work of your life, come join our table.  \n  \n<strong>Instacart is a Flex First team  \n  \n</strong>There’s no one-size fits all approach to how we do our best work. Our employees have the flexibility to choose where they do their best work—whether it’s from home, an office, or your favorite coffee shop—while staying connected and building community through regular in-person events. Learn more about our flexible approach to where we work.  \n  \n<strong>Overview  \n  \n</strong>Instacart is on a mission to make eating well effortless for everyone and great design is a key ingredient. As a Senior Design Program Manager, you'll drive operational excellence and programmatic execution across the Design organization—building AI-enabled systems, scaling critical processes, and managing the tools and vendor relationships that power our creative work.  \n  \nThis role sits at the intersection of design craft, technical operations, and strategic execution. You'll bring strong design sensibility—whether from product design or design systems—to build scalable programs, automate workflows using AI, and ensure our design team has the infrastructure, tools, and processes to deliver world-class experiences efficiently. You'll work closely with the Instacart Design System (IDS) team, requiring technical fluency to bridge design, engineering, and tooling infrastructure.  \n  \n<strong>About The Role  \n  \n</strong>You'll own end-to-end program execution for high-visibility design initiatives while building the operational backbone that enables the Design organization to scale. You'll leverage AI to automate workflows, manage critical vendor relationships (Figma, design tooling, contractors), and create repeatable systems that translate our design, creative and product strategy into shipped experiences.  \n  \nYou'll report to the Director of Technical Program Management and work closely with Design and Product Leadership, Marketing, Engineering, and several other cross-functional partners to deliver outcomes that matter.  \n  \n<strong>About The Job  \n  \n</strong>\n\n*   Programmatic Execution: Drive end-to-end delivery of complex, multi-quarter design initiatives across Design, Product, Engineering, Marketing, Legal, Business Development and other cross-functional teams. Enable seamless cross-functional collaboration and predictable program outcomes.\n*   AI Enablement: Build and deploy AI-enabled workflows that automate program management tasks—status reporting, resource tracking, documentation synthesis, and stakeholder communication. Champion AI fluency in Design to accelerate design-first thinking and increase operational efficiency.\n*   Operations & Vendor Management: Own strategic vendor relationships and contract management for design tooling (Figma, prototyping, asset management, collaboration platforms). Negotiate contracts, optimize licensing spend, and ensure infrastructure scales with growth. Manage contractor/agency relationships and partner with Finance, Legal, and IT on compliance and cost efficiency.\n*   Systems & Tooling: Champion team health through capacity planning, roadmapping, and resource allocation. Build operational metrics and tooling integrations that create seamless workflows across platforms.\n*   Design Systems & Cross-Functional Partnership: Partner with the Instacart Design System (IDS) team to align programs with system evolution and component adoption. Drive governance programs that scale IDS across product teams. Act as strategic partner to Product, Engineering, Marketing, Legal, and Operations. Translate design strategy into executable programs with clear visibility into progress and outcomes. Facilitate planning cycles and milestone reviews where design intersects with product roadmaps.\n*   Design Craft Integration: Apply design thinking and product sense to program design—understanding user needs, designing operational experiences, and iterating based on feedback. Build systems that empower designers and product managers to do their best work while balancing flexibility with consistency, creative exploration with scalable patterns, and craft excellence with business impact.  \n      \n    \n\n<strong>About You  \n  \n</strong><strong>Minimum Qualifications  \n  \n</strong>\n\n*   6+ years in program management and design operations within design or product organizations, with deep experience driving operational excellence and culture for design and product teams.\n*   Strong product sense and design craft sensibility, with well-developed methods and tools for driving fluid programs forward into the market.\n*   Experience with all stages of the product development lifecycle, launching products end-to-end.\n*   (component libraries, tokens, documentation, cross-platform patterns)\n*   Technical fluency to collaborate with design system and engineering teams—understanding system architecture, component APIs, design-to-code workflows, and technical constraints\n*   Proven track record driving complex, cross-functional programs from 0→1 and scaling operational systems in fast-paced environments\n*   AI fluency: Experience leveraging AI tools (LLMs, automation platforms) to drive efficiency and scale programs\n*   Vendor/contract management experience: negotiating software contracts, managing relationships, optimizing spend, ensuring compliance\n*   Deep knowledge of design and program management tooling ecosystems (Figma, Linear, Jira, Dovetail, asset management, prototyping tools)\n*   Ability to drive organizational change and influence cross-functional partners—bringing clarity to complexity\n*   Excellent communication and stakeholder management skills; comfortable presenting to executive leadership  \n      \n    \n\n<strong>Preferred Qualifications  \n  \n</strong>\n\n*   Design systems expertise: building/scaling systems, managing component libraries, defining tokens, driving adoption programs\n*   Experience building AI-powered workflows for creative operations or design tooling integrations\n*   Success translating leadership vision into actionable roadmaps and operating models\n*   Experience in hybrid/embedded team models with deep cross-functional partnership\n*   Comfort balancing hands-on execution with strategic oversight\n*   Track record using data and storytelling to influence leadership and secure buy-in for operational investments  \n      \n    \n\nInstacart provides highly market-competitive compensation and benefits in each location where our employees work. This role is remote and the base pay range for a successful candidate is dependent on their permanent work location. Please review our Flex First remote work policy here.  \n  \nOffers may vary based on many factors, such as candidate experience and skills required for the role. Additionally, this role is eligible for a new hire equity grant as well as annual refresh grants. Please read more about our benefits offerings here.  \n  \nFor US based candidates, the base pay ranges for a successful candidate are listed below.  \n  \nCA, NY, CT, NJ  \n  \n$214,000—$226,000 USD  \n  \nWA  \n  \n$205,000—$216,500 USD  \n  \nOR, DE, ME, MA, MD, NH, RI, VT, DC, PA, VA, CO, TX, IL, HI  \n  \n$196,000—$207,000 USD  \n  \nAll other states  \n  \n$178,000—$188,000 USD",
    "companyName": "Instacart",
    "closed": false,
    "url": "https://www.linkedin.com/jobs/view/senior-design-program-manager-ii-at-instacart-4475011756",
    "categories": [
      {
        "name": "Automation",
        "urlString": "automation"
      },
      {
        "name": "Figma",
        "urlString": "figma"
      },
      {
        "name": "AI",
        "urlString": "ai"
      },
      {
        "name": "Operations",
        "urlString": "operations"
      },
      {
        "name": "Wireframing/prototyping",
        "urlString": "wireframing-prototyping"
      },
      {
        "name": "Program Management",
        "urlString": "program-management"
      },
      {
        "name": "Community management",
        "urlString": "community-management"
      },
      {
        "name": "Marketing strategies",
        "urlString": "marketing-strategies"
      },
      {
        "name": "Infrastructure",
        "urlString": "infrastructure"
      },
      {
        "name": "Team collaboration",
        "urlString": "team-collaboration"
      },
      {
        "name": "Project documentation",
        "urlString": "project-documentation"
      },
      {
        "name": "Product design",
        "urlString": "product-design"
      },
      {
        "name": "Embedded Systems",
        "urlString": "embedded-systems"
      },
      {
        "name": "Design Systems",
        "urlString": "design-systems"
      },
      {
        "name": "Security software",
        "urlString": "security-software"
      },
      {
        "name": "Communications",
        "urlString": "communications"
      },
      {
        "name": "Compliance",
        "urlString": "compliance"
      },
      {
        "name": "Software Development",
        "urlString": "software-development"
      },
      {
        "name": "Vendor management",
        "urlString": "vendor-management"
      },
      {
        "name": "Growth",
        "urlString": "growth"
      },
      {
        "name": "Roadmap planning",
        "urlString": "roadmap-planning"
      },
      {
        "name": "Data",
        "urlString": "data"
      },
      {
        "name": "Storytelling",
        "urlString": "storytelling"
      },
      {
        "name": "System security",
        "urlString": "system-security"
      },
      {
        "name": "Jira",
        "urlString": "jira"
      },
      {
        "name": "Design thinking",
        "urlString": "design-thinking"
      },
      {
        "name": "Stakeholder management",
        "urlString": "stakeholder-management"
      },
      {
        "name": "Tooling",
        "urlString": "tooling"
      },
      {
        "name": "Advance prototyping",
        "urlString": "advance-prototyping"
      },
      {
        "name": "Multi platform",
        "urlString": "multi-platform"
      },
      {
        "name": "Component libraries",
        "urlString": "component-libraries"
      },
      {
        "name": "Tokenization",
        "urlString": "tokenization"
      },
      {
        "name": "Resource management",
        "urlString": "resource-management"
      }
    ],
    "techStackDetails": [
      {
        "name": "Automation",
        "urlString": "automation"
      },
      {
        "name": "Figma",
        "urlString": "figma"
      },
      {
        "name": "AI",
        "urlString": "ai"
      },
      {
        "name": "Operations",
        "urlString": "operations"
      },
      {
        "name": "Wireframing/prototyping",
        "urlString": "wireframing-prototyping"
      },
      {
        "name": "Program Management",
        "urlString": "program-management"
      },
      {
        "name": "Community management",
        "urlString": "community-management"
      },
      {
        "name": "Marketing strategies",
        "urlString": "marketing-strategies"
      },
      {
        "name": "Infrastructure",
        "urlString": "infrastructure"
      },
      {
        "name": "Team collaboration",
        "urlString": "team-collaboration"
      },
      {
        "name": "Project documentation",
        "urlString": "project-documentation"
      },
      {
        "name": "Product design",
        "urlString": "product-design"
      },
      {
        "name": "Embedded Systems",
        "urlString": "embedded-systems"
      },
      {
        "name": "Design Systems",
        "urlString": "design-systems"
      },
      {
        "name": "Security software",
        "urlString": "security-software"
      },
      {
        "name": "Communications",
        "urlString": "communications"
      },
      {
        "name": "Compliance",
        "urlString": "compliance"
      },
      {
        "name": "Software Development",
        "urlString": "software-development"
      },
      {
        "name": "Vendor management",
        "urlString": "vendor-management"
      },
      {
        "name": "Growth",
        "urlString": "growth"
      },
      {
        "name": "Roadmap planning",
        "urlString": "roadmap-planning"
      },
      {
        "name": "Data",
        "urlString": "data"
      },
      {
        "name": "Storytelling",
        "urlString": "storytelling"
      },
      {
        "name": "System security",
        "urlString": "system-security"
      },
      {
        "name": "Jira",
        "urlString": "jira"
      },
      {
        "name": "Design thinking",
        "urlString": "design-thinking"
      },
      {
        "name": "Stakeholder management",
        "urlString": "stakeholder-management"
      },
      {
        "name": "Tooling",
        "urlString": "tooling"
      },
      {
        "name": "Advance prototyping",
        "urlString": "advance-prototyping"
      },
      {
        "name": "Multi platform",
        "urlString": "multi-platform"
      },
      {
        "name": "Component libraries",
        "urlString": "component-libraries"
      },
      {
        "name": "Tokenization",
        "urlString": "tokenization"
      },
      {
        "name": "Resource management",
        "urlString": "resource-management"
      }
    ],
    "company": {
      "name": "Instacart",
      "randomKey": "alug36y5gh",
      "remoteLevel": "hybrid",
      "country": "United States",
      "city": "San Francisco"
    }
  }
};

const origin = 'https://arc.dev';
const listUrl = `${origin}/remote-jobs`;
const source = { _id: 'arc', name: 'Arc', connectorFamily: 'PublicHtml', endpoint: { baseUrl: listUrl }, config: {}, timeoutMs: 20_000 };
const copy = value => structuredClone(value);
const context = overrides => ({ source, requestId: 'arc-native-test', checkpoint: {}, backfillDays: 30, backfillSince: '2026-09-06T18:00:00.000Z', ...overrides });
function fixed(t) { t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T18:00:00.000Z') }); }
function urlFor(card, kind) { return `${origin}/remote-jobs/${kind === 'exclusive' ? 'details' : 'j'}/${card.urlString}-${card.randomKey}`; }
function pageHtml(page, props, url, query = {}) {
  const anchors = page === '/remote-jobs' ? [
    ...(props.arcJobs ?? []).slice(0, 6).map(card => `<a href="${urlFor(card, 'exclusive').slice(origin.length)}">${card.title}</a>`),
    ...(props.externalJobs ?? []).slice(0, 4).map(card => `<a href="${urlFor(card, 'external').slice(origin.length)}">${card.title}</a>`),
  ].join('') : '';
  return `<html><head><link rel="canonical" href="${url}"></head><body>${anchors}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ page, query, buildId: fixture.buildId, props: { pageProps: props } })}</script></body></html>`;
}
function listHtml(props = fixture.listing, query = {}) { return pageHtml('/remote-jobs', props, listUrl, query); }
function detailHtml(card, kind, overrides = {}) {
  const isObserved = card.randomKey === fixture.exclusiveJob.randomKey || card.randomKey === fixture.externalJob.randomKey;
  const job = isObserved ? copy(kind === 'exclusive' ? fixture.exclusiveJob : fixture.externalJob) : {
    randomKey: card.randomKey, title: card.title, urlString: card.urlString,
    ...(kind === 'exclusive' ? { jobType: card.jobType } : { contractType: card.jobType }),
    postedAt: card.postedAt, closed: false, description: 'Synthetic native detail body for continuation identity and window checks.',
  };
  Object.assign(job, overrides);
  const url = urlFor(card, kind);
  return pageHtml(`/remote-jobs/${kind === 'exclusive' ? 'details' : 'j'}/[urlString]`, { job, outreachToken: 'must-not-be-retained', _sentryTraceData: 'must-not-be-retained' }, url, { urlString: `${card.urlString}-${card.randomKey}` });
}
function transport(props = fixture.listing, alterDetail = (_card, _kind, html) => html) {
  const calls = [];
  return {
    calls,
    async extractUrl(url, options) {
      calls.push(url);
      assert.deepEqual(options.allowedHosts, ['arc.dev']);
      assert.equal(options.maxBytes, 3_000_000);
      if (url === listUrl) return { finalUrl: url, html: listHtml(props), metadata: { publicFixture: true } };
      for (const [kind, feed] of [['exclusive', props.arcJobs], ['external', props.externalJobs]]) {
        const card = feed.find(item => urlFor(item, kind) === url);
        if (card) return { finalUrl: url, html: alterDetail(card, kind, detailHtml(card, kind)), metadata: { publicFixture: true } };
      }
      throw new Error(`Unexpected native URL ${url}`);
    },
  };
}
function smallProps() { return { arcJobs: [copy(fixture.listing.arcJobs[0])], externalJobs: [copy(fixture.listing.externalJobs[0])], totalExternalJobCount: 8222 }; }

describe('Arc anonymous native SSR contract', () => {
  it('retains both actual full detail projections, native IDs/types/dates/body and unambiguous hourly period without invented currency or client', async t => {
    fixed(t);
    const result = await new ArcConnector(transport(smallProps())).fetchPage(context());
    assert.equal(result.records.length, 2);
    const [freelance, vacancy] = result.records;
    assert.equal(freelance.externalId, 'ppe7qpiw2f');
    assert.equal(freelance.type, 'freelance');
    assert.equal(freelance.companyOrClient, undefined);
    assert.equal(freelance.description, fixture.exclusiveJob.description.trim());
    assert.equal(freelance.publishedAt.toISOString(), new Date(1791215571 * 1000).toISOString());
    assert.deepEqual([freelance.sourceMetadata.salary.from, freelance.sourceMetadata.salary.to, freelance.sourceMetadata.salary.period], [35, 55, 'hour']);
    assert.equal(freelance.sourceMetadata.salary.currency, undefined);
    assert.equal(freelance.sourceMetadata.salary.currencyKnown, false);
    assert.deepEqual(freelance.sourceMetadata.locations, ['worldwide']);
    assert.ok(freelance.sourceMetadata.skills.includes('Python'));
    assert.equal(vacancy.externalId, 'o9ahbnwkgx');
    assert.equal(vacancy.type, 'vacancy');
    assert.equal(vacancy.companyOrClient, 'Instacart');
    assert.equal(vacancy.sourceMetadata.salary, undefined, 'Distinct regional body ranges cannot become one guessed canonical salary');
    assert.ok(vacancy.description.includes('214,000'));
    assert.ok(vacancy.description.includes('All other states'));
    assert.ok(!vacancy.description.includes('<p>'));
    assert.deepEqual(vacancy.sourceMetadata.locations, fixture.externalJob.requiredCountries);
    assert.ok(!vacancy.sourceMetadata.location.includes('San Francisco'));
    assert.equal(vacancy.sourceStatus, 'Active');
    assert.equal(freelance.rawPayload.outreachToken, undefined);
    assert.equal(freelance.rawPayload._sentryTraceData, undefined);
    assert.equal(JSON.stringify(freelance.rawPayload).includes('must-not-be-retained'), false);
    const normalized = new SourceNormalizerService().normalize(source, freelance);
    assert.deepEqual([normalized.money.min, normalized.money.max, normalized.money.period], [35, 55, 'hour']);
    assert.equal(normalized.money.currency, undefined);
    assert.equal(normalized.publishedAt.getTime(), 1791215571000);
    assert.equal(result.checkpoint.incomplete, true);
    assert.equal(result.checkpoint.catalogComplete, false);
    assert.equal(result.checkpoint.terminalReason, 'native-public-registration-boundary');
  });

  it('maps the actual fulltime detail alias and retains unknown scalar detail labels without discarding the verified catalog job', async t => {
    fixed(t);
    // Actual pnbwza8npq detail, observed after the same original queue run failed on its second batch.
    const job = {
    "randomKey": "pnbwza8npq",
    "title": "Remote - Software Developer",
    "jobType": "fulltime",
    "urlString": "remote-software-developer",
    "description": "### Join Our Team at UNIPREP\n\nAre you passionate about software development and eager to kickstart your career as a Junior Full-Stack Developer? Look no further! At UNIPREP, we are dedicated to providing a platform that empowers individuals to access international education and excel in their professional growth journey.\n\n### About Us\n\nUNIPREP is committed to offering a comprehensive platform that not only facilitates access to international education but also provides users with opportunities for skill enhancement and career guidance. Our mission is to empower individuals to reach their full potential through our innovative solutions.\n\n### Role Overview\n\nAs a Junior Full-Stack Developer at UNIPREP, you will have the exciting opportunity to work with cutting-edge technologies such as Python, Node.js, JavaScript, and AWS. You will be an integral part of our dynamic team, contributing to the development of our platform and ensuring a seamless user experience for our global audience.\n\n### What We Offer\n\nJoining our team means being part of a collaborative environment where your ideas are valued, and your growth is encouraged. As a Junior Full-Stack Developer, you will have the chance to enhance your skills, learn from experienced professionals, and make a meaningful impact on the future of education and career development.\n\n### Apply Now\n\nIf you are a motivated individual with a passion for software development and a desire to make a difference, we want to hear from you! Take the first step towards an exciting career at UNIPREP by applying for the Junior Full-Stack Developer role today. Let's shape the future together!",
    "createdAt": 1790504832,
    "updatedAt": 1790504874,
    "closed": false,
    "state": "opened",
    "aasmState": "open",
    "requiredCountries": [],
    "requiredLocations": [
        "worldwide"
    ],
    "company": null,
    "minAnnualSalary": 50000,
    "maxAnnualSalary": 100000,
    "minHourlyRate": 0,
    "maxHourlyRate": 0,
    "experienceLevel": "junior",
    "categories": [
        {
            "name": "Python",
            "urlString": "python"
        },
        {
            "name": "Node.js",
            "urlString": "nodejs"
        },
        {
            "name": "Software Development",
            "urlString": "software-development"
        },
        {
            "name": "JavaScript",
            "urlString": "javascript"
        },
        {
            "name": "AWS",
            "urlString": "aws"
        }
    ]
};
    const card = copy(fixture.listing.arcJobs.find(item => item.randomKey === job.randomKey));
    assert.equal(card.jobType, 'permanent');
    const props = { arcJobs: [card], externalJobs: [], totalExternalJobCount: 8222 };
    const url = urlFor(card, 'exclusive');
    const html = nativeJob => pageHtml('/remote-jobs/details/[urlString]', { job: nativeJob }, url, { urlString: card.urlString + '-' + card.randomKey });
    const result = await new ArcConnector(transport(props, () => html(job))).fetchPage(context());
    const record = result.records[0];
    assert.equal(record.type, 'vacancy');
    assert.equal(record.externalId, 'pnbwza8npq');
    assert.equal(record.description, job.description.trim());
    assert.equal(record.rawPayload.nativeJob.jobType, 'fulltime');
    assert.equal(record.rawPayload.nativeCard.jobType, 'permanent');
    assert.equal(record.sourceMetadata.employmentType, 'permanent');
    assert.equal(record.sourceMetadata.employmentTypeKnown, true);
    assert.equal(record.sourceMetadata.opportunityTypeBasis, 'detail-native-job-type');
    for (const unknown of ['unrecognized-native-label', '', null, undefined]) {
      const nativeJob = { ...copy(job), jobType: unknown };
      const before = copy(nativeJob);
      const retained = await new ArcConnector(transport(props, () => html(nativeJob))).fetchPage(context());
      const mapped = retained.records[0];
      assert.equal(mapped.type, 'vacancy');
      assert.equal(mapped.description, job.description.trim());
      assert.equal(mapped.rawPayload.nativeJob.jobType, unknown);
      assert.equal(mapped.sourceMetadata.nativeCatalogJobType, 'permanent');
      assert.equal(mapped.sourceMetadata.employmentType, undefined);
      assert.equal(mapped.sourceMetadata.employmentTypeKnown, false);
      assert.equal(mapped.sourceMetadata.nativeDetailJobTypeKnown, false);
      assert.equal(mapped.sourceMetadata.opportunityTypeBasis, 'catalog-native-job-type-detail-employment-unspecified');
      assert.deepEqual(nativeJob, before);
    }
    await assert.rejects(() => new ArcConnector(transport(props, () => html({ ...job, jobType: { guessed: 'fulltime' } }))).fetchPage(context()), /scalar string/);
    await assert.rejects(() => new ArcConnector(transport(props, () => html({ ...job, jobType: 'contract' }))).fetchPage(context()), /differs from its catalog/);
  });

  it('resumes the real 30+30 native identity snapshot in bounded batches; terminal is explicitly incomplete rather than claiming the 8,222 catalog', async t => {
    fixed(t);
    const extraction = transport();
    const connector = new ArcConnector(extraction);
    const original = copy(fixture.listing);
    let result = await connector.fetchPage(context());
    assert.equal(result.records.length, 10);
    assert.equal(result.checkpoint.pending.length, 50);
    assert.equal(result.checkpoint.incomplete, false);
    assert.equal(result.checkpoint.externalTotalObserved, 8222);
    const records = [...result.records];
    const since = result.checkpoint.windowSince;
    const until = result.checkpoint.windowUntil;
    let seen = result.stats.seen;
    while (result.hasMore) {
      const retained = JSON.parse(JSON.stringify(result.checkpoint, (_key, value) => value === undefined ? null : value));
      const unchanged = copy(retained);
      result = await connector.fetchPage(context({ checkpoint: retained, page: result.nextPage, backfillSince: '2026-10-06T00:00:00.000Z' }));
      assert.deepEqual(retained, unchanged, 'BSON-style continuation is read without mutating retained checkpoint/raw facts');
      records.push(...result.records);
      seen += result.stats.seen;
      assert.equal(result.checkpoint.windowSince, since);
      assert.equal(result.checkpoint.windowUntil, until);
    }
    assert.equal(seen, 60);
    assert.equal(records.length, 60);
    assert.equal(new Set(records.map(record => record.externalId)).size, 60);
    assert.ok(records.some(record => record.type === 'freelance'));
    assert.ok(records.some(record => record.type === 'vacancy'));
    assert.equal(extraction.calls.filter(url => url === listUrl).length, 1);
    assert.equal(extraction.calls.length, 61);
    assert.equal(result.checkpoint.processedIds.length, 60);
    assert.equal(result.checkpoint.pending.length, 0);
    assert.equal(result.checkpoint.incomplete, true);
    assert.equal(result.checkpoint.catalogComplete, false);
    assert.match(result.checkpoint.limitation, /unproved/);
    assert.deepEqual(fixture.listing, original);
    const calls = extraction.calls.length;
    const terminal = await connector.fetchPage(context({ checkpoint: result.checkpoint }));
    assert.equal(terminal.records.length, 0);
    assert.equal(terminal.hasMore, false);
    assert.equal(terminal.checkpoint.incomplete, true);
    assert.equal(extraction.calls.length, calls, 'A terminal retained checkpoint must not silently restart the catalog');
  });

  it('keeps unknown publication dates honest even when createdAt/updatedAt exist and BSON stores null', async t => {
    fixed(t);
    const props = smallProps();
    props.arcJobs[0].postedAt = null;
    props.externalJobs = [];
    const extraction = transport(props, (card, kind) => detailHtml(card, kind, { postedAt: null }));
    const result = await new ArcConnector(extraction).fetchPage(context());
    assert.equal(result.records[0].publishedAt, undefined);
    assert.equal(result.records[0].sourceMetadata.publicationDateKnown, false);
    assert.equal(result.records[0].sourceMetadata.publicationDateBasis, 'unknown');
    assert.ok(result.records[0].rawPayload.nativeJob.createdAt);
    assert.ok(result.records[0].updatedAt);
  });

  it('uses the frozen original run window and includes its exact publication boundaries', async t => {
    fixed(t);
    const props = smallProps();
    const first = props.arcJobs[0].postedAt;
    const boundary = new Date(first * 1000).toISOString();
    const result = await new ArcConnector(transport(props)).fetchPage(context({ backfillDays: 1, backfillSince: boundary }));
    assert.equal(result.records.length, 2);
    assert.equal(result.checkpoint.windowSince, boundary);
    assert.equal(result.checkpoint.windowUntil, new Date(first * 1000 + 86400000).toISOString());
    const older = await new ArcConnector(transport(props)).fetchPage(context({ backfillSince: '2026-10-06T00:00:00.000Z' }));
    assert.equal(older.records.length, 0);
    assert.equal(older.checkpoint.excludedIds.length, 2);
    assert.equal(older.checkpoint.incomplete, true);
  });

  it('clamps delayed effective 31-day context without moving the original 30-day run boundaries', async t => {
    fixed(t);
    const lower = '2026-09-06T17:59:59.999Z';
    assert.equal(Math.ceil((Date.now() - Date.parse(lower)) / 86400000), 31);
    const result = await new ArcConnector(transport(smallProps())).fetchPage(context({ backfillDays: 31, backfillSince: lower }));
    assert.equal(result.records.length, 2);
    assert.equal(result.checkpoint.windowSince, lower);
    assert.equal(result.checkpoint.windowUntil, '2026-10-06T17:59:59.999Z');
    assert.equal(Date.parse(result.checkpoint.windowUntil) - Date.parse(result.checkpoint.windowSince), 30 * 86400000);
    assert.equal(result.checkpoint.incomplete, true);
  });

  it('fails before HTTP on unsafe config, wrong source identity and malformed backfill scope', async t => {
    fixed(t);
    const extraction = transport();
    const connector = new ArcConnector(extraction);
    for (const baseUrl of ['https://localhost/remote-jobs', 'https://evil.invalid/remote-jobs', 'https://arc.dev/remote-jobs?page=2', 'https://user:secret@arc.dev/remote-jobs', 'https://arc.dev/remote-jobs#next', 'http://arc.dev/remote-jobs', 'https://arc.dev/remote-jobs/']) {
      assert.equal((await connector.validateConfig({ baseUrl })).ok, false);
      await assert.rejects(() => connector.fetchPage(context({ source: { ...source, config: { baseUrl } } })), /Arc/);
    }
    await assert.rejects(() => connector.fetchPage(context({ source: { ...source, _id: 'another-source' } })), /source identity/);
    for (const backfillDays of [0, -1, 1.5, Infinity]) await assert.rejects(() => connector.fetchPage(context({ backfillDays })), /positive integer/);
    await assert.rejects(() => connector.fetchPage(context({ backfillSince: '2026-11-01T00:00:00.000Z' })), /future/);
    assert.equal(extraction.calls.length, 0);
    assert.equal((await connector.validateConfig({ baseUrl: listUrl })).ok, true);
  });

  it('rejects homepage/challenge/error states, native filter drift, repeated identities and unsupported types/timestamps', async t => {
    fixed(t);
    const badPages = ['<h1>Access denied</h1>', pageHtml('/', fixture.listing, listUrl), listHtml(fixture.listing, { page: '2' })];
    for (const html of badPages) await assert.rejects(() => new ArcConnector({ async extractUrl(url) { return { finalUrl: url, html }; } }).fetchPage(context()), /native|Next.js|filters/);
    for (const edit of [
      props => { props.arcJobs[0].randomKey = 'invalid'; },
      props => { props.arcJobs[0].title = ''; },
      props => { props.arcJobs[0].urlString = '../../admin'; },
      props => { props.arcJobs[0].postedAt = '2026-10-05'; },
      props => { props.arcJobs[0].postedAt *= 1000; },
      props => { props.arcJobs[0].jobType = 'unknown'; },
      props => { props.externalJobs[0].randomKey = props.arcJobs[0].randomKey; },
      props => { props.totalExternalJobCount = 0; },
    ]) {
      const props = smallProps(); edit(props);
      await assert.rejects(() => new ArcConnector(transport(props)).fetchPage(context()), /Arc/);
    }
    await assert.rejects(() => new ArcConnector(transport({ arcJobs: [], externalJobs: [], totalExternalJobCount: 0 })).fetchPage(context()), /empty catalog/);
  });

  it('requires matching native detail identity, route, canonical URL, type and full body rather than treating page text as the job', async t => {
    fixed(t);
    const props = smallProps(); props.externalJobs = [];
    for (const overrides of [{ randomKey: 'aaaaaaaaaa' }, { urlString: 'another-job' }, { jobType: 'permanent' }, { description: '' }, { postedAt: 'yesterday' }]) {
      await assert.rejects(() => new ArcConnector(transport(props, (card, kind) => detailHtml(card, kind, overrides))).fetchPage(context()), /Arc/);
    }
    for (const alter of [
      html => html.replace('"page":"/remote-jobs/details/[urlString]"', '"page":"/remote-jobs/j/[urlString]"'),
      html => html.replace('rel="canonical"', 'rel="alternate"'),
      html => html.replace('"query":{"urlString":', '"query":{"page":"2","urlString":'),
    ]) await assert.rejects(() => new ArcConnector(transport(props, (_card, _kind, html) => alter(html))).fetchPage(context()), /Arc/);
  });

  it('rejects corrupted continuation history, pending URL/ID/type and frozen window before HTTP', async t => {
    fixed(t);
    const result = await new ArcConnector(transport()).fetchPage(context());
    for (const edit of [
      cp => { cp.pending[0].id = 'aaaaaaaaaa'; },
      cp => { cp.pending[0].url = 'https://evil.invalid/job'; },
      cp => { cp.pending[0].kind = 'private'; },
      cp => { cp.pending[0].job.title = null; },
      cp => { cp.processedIds.push(cp.pending[0].id); },
      cp => { cp.catalogIds.push('aaaaaaaaaa'); },
      cp => { cp.hasMore = false; },
      cp => { cp.externalTotalObserved = 0; },
      cp => { cp.windowSince = '2025-01-01T00:00:00.000Z'; },
    ]) {
      const checkpoint = copy(result.checkpoint); edit(checkpoint);
      const extraction = transport();
      await assert.rejects(() => new ArcConnector(extraction).fetchPage(context({ checkpoint })), /Arc/);
      assert.equal(extraction.calls.length, 0);
    }
  });

  it('does not mutate a retained checkpoint on a failed detail, discard the card or move its continuation', async t => {
    fixed(t);
    const first = await new ArcConnector(transport()).fetchPage(context());
    const checkpoint = copy(first.checkpoint);
    const before = copy(checkpoint);
    const extraction = { async extractUrl() { throw new Error('Native public detail returned HTTP 404'); } };
    await assert.rejects(() => new ArcConnector(extraction).fetchPage(context({ checkpoint })), /HTTP 404/);
    assert.deepEqual(checkpoint, before);
  });

  it('retains the exact native category redirect as catalog-only without ingesting category text; unrelated redirects still fail', async t => {
    fixed(t);
    const card = copy(fixture.listing.arcJobs.find(item => item.randomKey === 'pkmiiyi85w'));
    const url = urlFor(card, 'exclusive');
    const target = origin + '/remote-jobs/full-stack';
    // Actual HTTP308 target has this native route/query, arrays and no job object. This wrapper isolates the redirect guard.
    const category = pageHtml('/remote-jobs/[urlSearchQuery]', { arcJobs: [], externalJobs: [], totalExternalJobCount: 0 }, target, { urlSearchQuery: 'full-stack' }).replace('<body>', '<body><h1>Remote full-stack developer jobs</h1><p>CATEGORY TEXT MUST NOT BECOME THE JOB BODY</p>');
    const props = { arcJobs: [card], externalJobs: [], totalExternalJobCount: 8222 };
    const extraction = (finalUrl = target, html = category) => ({ async extractUrl(requested) { return { finalUrl: requested === listUrl ? listUrl : finalUrl, html: requested === listUrl ? listHtml(props) : html }; } });
    const before = copy(card);
    const result = await new ArcConnector(extraction()).fetchPage(context());
    const record = result.records[0];
    assert.equal(record.externalId, 'pkmiiyi85w');
    assert.equal(record.url, url);
    assert.equal(record.title, card.title);
    assert.equal(record.type, 'vacancy');
    assert.equal(record.sourceStatus, 'Unknown');
    assert.equal(record.description, undefined);
    assert.equal(record.publishedAt.getTime(), card.postedAt * 1000);
    assert.deepEqual(record.rawPayload.nativeCard, before);
    assert.equal(record.rawPayload.nativeJob, undefined);
    assert.equal(record.rawPayload.nativeUnavailableDetail.finalUrl, target);
    assert.equal(JSON.stringify(record.rawPayload).includes('CATEGORY TEXT'), false);
    assert.equal(record.sourceMetadata.detailCompleteness, 'catalog-only-native-category-redirect');
    assert.equal(record.sourceMetadata.nativeDetailAvailability, 'unavailable-redirected-to-native-category');
    assert.equal(record.sourceMetadata.fullDescriptionAvailable, false);
    assert.equal(record.sourceMetadata.descriptionBasis, 'unavailable');
    assert.equal(result.checkpoint.incomplete, true);
    assert.equal(result.checkpoint.windowSince, context().backfillSince);
    assert.equal(result.checkpoint.processedIds[0], card.randomKey);
    assert.deepEqual(card, before);
    card.description = 'Retained catalog body only.';
    const retained = await new ArcConnector(extraction()).fetchPage(context());
    assert.equal(retained.records[0].description, card.description);
    assert.equal(retained.records[0].sourceMetadata.descriptionBasis, 'native-catalog-description');
    assert.equal(retained.records[0].sourceMetadata.fullDescriptionAvailable, false);
    for (const other of [origin + '/remote-jobs/python', origin + '/remote-jobs', target + '?page=2', 'https://elsewhere.invalid/remote-jobs/full-stack']) await assert.rejects(() => new ArcConnector(extraction(other)).fetchPage(context()), /Arc/);
    for (const bad of [
      '<h1>Category unavailable</h1>',
      category.replace('"urlSearchQuery":"full-stack"', '"urlSearchQuery":"python"'),
      category.replace('rel="canonical"', 'rel="alternate"'),
      category.replace('"totalExternalJobCount":0', '"job":{"title":"Another job"},"totalExternalJobCount":0'),
    ]) await assert.rejects(() => new ArcConnector(extraction(target, bad)).fetchPage(context()), /Arc/);
  });

  it('relabels a legacy terminal checkpoint with the proved registration boundary without changing IDs/history/window or doing HTTP', async t => {
    fixed(t);
    const first = await new ArcConnector(transport(smallProps())).fetchPage(context());
    const legacy = copy(first.checkpoint);
    legacy.terminalReason = 'native-catalog-pagination-unverified';
    legacy.limitation = 'Earlier public pagination contract was merely unverified.';
    delete legacy.publicCatalogAccess;
    const before = copy(legacy);
    const extraction = transport(smallProps());
    const result = await new ArcConnector(extraction).fetchPage(context({ checkpoint: legacy }));
    assert.equal(extraction.calls.length, 0);
    assert.equal(result.records.length, 0);
    assert.equal(result.hasMore, false);
    assert.equal(result.checkpoint.incomplete, true);
    assert.equal(result.checkpoint.catalogComplete, false);
    assert.equal(result.checkpoint.terminalReason, 'native-public-registration-boundary');
    assert.equal(result.checkpoint.publicCatalogAccess.boundary, 'registration-required-by-native-public-ui');
    assert.equal(result.checkpoint.publicAccess, 'registration-required-for-full-catalog');
    assert.equal(result.checkpoint.fullCatalogRequiresCredentials, true);
    assert.equal(result.checkpoint.publicCatalogAccess.publicUiRegistrationGateObserved, true);
    assert.equal(result.checkpoint.publicCatalogAccess.signupUrl, 'https://arc.dev/signup?userType=developer');
    assert.equal(result.checkpoint.publicCatalogAccess.authenticatedPaginationVerified, false);
    assert.match(result.checkpoint.limitation, /30 Arc and 30 external/);
    assert.match(result.checkpoint.limitation, /6 featured and 4 external/);
    for (const key of ['catalogIds', 'processedIds', 'excludedIds', 'pending', 'batches', 'windowSince', 'windowUntil', 'arcLoaded', 'externalLoaded', 'externalTotalObserved', 'listingBuildId']) assert.deepEqual(result.checkpoint[key], before[key], key + ' must be preserved');
    assert.deepEqual(legacy, before);
    for (const record of first.records) {
      assert.equal(record.sourceMetadata.publicAccess, 'registration-required-for-full-catalog');
      assert.equal(record.sourceMetadata.fullCatalogRequiresCredentials, true);
      assert.equal(record.sourceMetadata.publicCatalogAccess.publicUiRegistrationGateObserved, true);
      assert.equal(record.sourceMetadata.publicCatalogAccess.authenticatedPaginationVerified, false);
    }
  });

  it('reports the proved public registration boundary as degraded while the authenticated protocol remains unverified', async () => {
    const health = await new ArcConnector(transport()).healthCheck({ source, requestId: 'arc-health' });
    assert.equal(health.state, 'Degraded');
    assert.equal(health.details.cards, 60);
    assert.equal(health.details.externalTotal, 8222);
    assert.match(health.details.limitation, /unproved/);
    assert.match(health.message, /requires registration/);
    assert.equal(health.details.publicCatalogAccess.publicUiRegistrationGateObserved, true);
    assert.equal(health.details.publicCatalogAccess.authenticatedPaginationVerified, false);
    assert.equal(health.details.publicAccess, 'registration-required-for-full-catalog');
    assert.equal(health.details.fullCatalogRequiresCredentials, true);
    assert.equal(new ArcConnector(transport()).capabilities().requiresCredentials, false);
  });
});
