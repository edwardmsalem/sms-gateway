const MONDAY_API_URL = 'https://api.monday.com/v2';
const ASSOCIATES_BOARD_ID = '7511353761';
const DEALS_BOARD_ID = '7511353910';
const EXTERNAL_EMAILS_BOARD_ID = '18391136284';
const IGNORED_STATUSES = ['Closed'];

async function mondayQuery(query, variables = {}) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN environment variable is not set');
  }

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2024-01'
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`Monday.com API returned HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.errors) {
    const errorMsg = data.errors[0]?.message || JSON.stringify(data.errors);
    throw new Error('Monday.com query failed: ' + errorMsg);
  }
  return data.data;
}

async function buildAssociateMap() {
  const query = `
    query ($boardId: [ID!]!) {
      boards(ids: $boardId) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  const result = await mondayQuery(query, { boardId: [ASSOCIATES_BOARD_ID] });
  const items = result.boards[0]?.items_page?.items || [];

  const associateMap = {};

  for (const item of items) {
    let phone = null;
    let closer = null;

    for (const col of item.column_values) {
      if (col.id === 'ss_mobile' && col.text && col.text !== 'null' && col.text.length >= 10) {
        phone = col.text;
      }
      if (col.id === 'lead_closer' && col.text && col.text !== 'null') {
        closer = col.text;
      }
    }

    if (phone) {
      const normalizedPhone = phone.replace(/\D/g, '');
      associateMap[item.id] = {
        name: item.name,
        phone: normalizedPhone,
        closer: closer
      };
    }
  }

  return associateMap;
}

async function lookupDealsByPhone(phoneNumber) {
  const inputPhone = phoneNumber.replace(/\D/g, '');
  const phoneVariants = [inputPhone];
  if (inputPhone.startsWith('1') && inputPhone.length === 11) {
    phoneVariants.push(inputPhone.substring(1));
  } else if (inputPhone.length === 10) {
    phoneVariants.push('1' + inputPhone);
  }

  const associateMap = await buildAssociateMap();

  const query = `
    query ($boardId: [ID!]!) {
      boards(ids: $boardId) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  const result = await mondayQuery(query, { boardId: [DEALS_BOARD_ID] });
  const items = result.boards[0]?.items_page?.items || [];

  const matchingDeals = [];

  for (const item of items) {
    const statusCol = item.column_values.find(cv => cv.id === 'lead_status__1');
    const dealStatus = statusCol?.text || '';
    if (IGNORED_STATUSES.includes(dealStatus)) continue;

    const dealContactCol = item.column_values.find(cv => cv.id === 'deal_contact');
    let associateId = null;
    if (dealContactCol?.value) {
      try {
        const parsed = JSON.parse(dealContactCol.value);
        associateId = parsed.linkedPulseIds?.[0]?.linkedPulseId;
      } catch (e) {}
    }

    const associateInfo = associateId ? associateMap[associateId] : null;
    if (!associateInfo?.phone) continue;

    const assocPhone = associateInfo.phone;
    const assocPhoneShort = assocPhone.startsWith('1') ? assocPhone.substring(1) : assocPhone;
    const assocPhoneLong = assocPhone.startsWith('1') ? assocPhone : '1' + assocPhone;

    if (!phoneVariants.includes(assocPhone) &&
        !phoneVariants.includes(assocPhoneShort) &&
        !phoneVariants.includes(assocPhoneLong)) {
      continue;
    }

    const teamCol = item.column_values.find(cv => cv.id === 'main_team');
    const team = teamCol?.text || item.name.split(' - ')[1] || '';

    matchingDeals.push({
      id: item.id,
      name: item.name,
      associateName: associateInfo.name || item.name.split(' - ')[0],
      closer: associateInfo.closer,
      team: team,
      status: dealStatus
    });
  }

  return matchingDeals;
}

const AREA_CODE_TO_STATE = {
  '480': 'AZ', '520': 'AZ', '602': 'AZ', '623': 'AZ', '928': 'AZ',
  '209': 'CA', '213': 'CA', '310': 'CA', '323': 'CA', '408': 'CA', '415': 'CA',
  '424': 'CA', '510': 'CA', '530': 'CA', '559': 'CA', '562': 'CA', '619': 'CA',
  '626': 'CA', '650': 'CA', '657': 'CA', '661': 'CA', '669': 'CA', '707': 'CA',
  '714': 'CA', '747': 'CA', '760': 'CA', '805': 'CA', '818': 'CA', '831': 'CA',
  '858': 'CA', '909': 'CA', '916': 'CA', '925': 'CA', '949': 'CA', '951': 'CA',
  '303': 'CO', '719': 'CO', '720': 'CO', '970': 'CO',
  '239': 'FL', '305': 'FL', '321': 'FL', '352': 'FL', '386': 'FL', '407': 'FL',
  '561': 'FL', '727': 'FL', '754': 'FL', '772': 'FL', '786': 'FL', '813': 'FL',
  '850': 'FL', '863': 'FL', '904': 'FL', '941': 'FL', '954': 'FL',
  '229': 'GA', '404': 'GA', '470': 'GA', '478': 'GA', '678': 'GA', '706': 'GA',
  '762': 'GA', '770': 'GA', '912': 'GA',
  '217': 'IL', '224': 'IL', '309': 'IL', '312': 'IL', '331': 'IL', '618': 'IL',
  '630': 'IL', '708': 'IL', '773': 'IL', '779': 'IL', '815': 'IL', '847': 'IL',
  '219': 'IN', '260': 'IN', '317': 'IN', '463': 'IN', '574': 'IN', '765': 'IN', '812': 'IN',
  '225': 'LA', '318': 'LA', '337': 'LA', '504': 'LA', '985': 'LA',
  '240': 'MD', '301': 'MD', '410': 'MD', '443': 'MD', '667': 'MD',
  '339': 'MA', '351': 'MA', '413': 'MA', '508': 'MA', '617': 'MA', '774': 'MA', '781': 'MA', '857': 'MA', '978': 'MA',
  '231': 'MI', '248': 'MI', '269': 'MI', '313': 'MI', '517': 'MI', '586': 'MI',
  '616': 'MI', '734': 'MI', '810': 'MI', '906': 'MI', '947': 'MI', '989': 'MI',
  '218': 'MN', '320': 'MN', '507': 'MN', '612': 'MN', '651': 'MN', '763': 'MN', '952': 'MN',
  '314': 'MO', '417': 'MO', '573': 'MO', '636': 'MO', '660': 'MO', '816': 'MO',
  '201': 'NJ', '551': 'NJ', '609': 'NJ', '732': 'NJ', '848': 'NJ', '856': 'NJ', '862': 'NJ', '908': 'NJ', '973': 'NJ',
  '212': 'NY', '315': 'NY', '332': 'NY', '347': 'NY', '516': 'NY', '518': 'NY',
  '585': 'NY', '607': 'NY', '631': 'NY', '646': 'NY', '680': 'NY', '716': 'NY',
  '718': 'NY', '845': 'NY', '914': 'NY', '917': 'NY', '929': 'NY', '934': 'NY',
  '252': 'NC', '336': 'NC', '704': 'NC', '743': 'NC', '828': 'NC', '910': 'NC', '919': 'NC', '980': 'NC', '984': 'NC',
  '216': 'OH', '220': 'OH', '234': 'OH', '330': 'OH', '380': 'OH', '419': 'OH',
  '440': 'OH', '513': 'OH', '567': 'OH', '614': 'OH', '740': 'OH', '937': 'OH',
  '405': 'OK', '539': 'OK', '580': 'OK', '918': 'OK',
  '458': 'OR', '503': 'OR', '541': 'OR', '971': 'OR',
  '215': 'PA', '223': 'PA', '267': 'PA', '272': 'PA', '412': 'PA', '445': 'PA',
  '484': 'PA', '570': 'PA', '610': 'PA', '717': 'PA', '724': 'PA', '814': 'PA', '878': 'PA',
  '423': 'TN', '615': 'TN', '629': 'TN', '731': 'TN', '865': 'TN', '901': 'TN', '931': 'TN',
  '210': 'TX', '214': 'TX', '254': 'TX', '281': 'TX', '325': 'TX', '346': 'TX',
  '361': 'TX', '409': 'TX', '430': 'TX', '432': 'TX', '469': 'TX', '512': 'TX',
  '682': 'TX', '713': 'TX', '726': 'TX', '737': 'TX', '806': 'TX', '817': 'TX',
  '830': 'TX', '832': 'TX', '903': 'TX', '915': 'TX', '936': 'TX', '940': 'TX',
  '956': 'TX', '972': 'TX', '979': 'TX',
  '385': 'UT', '435': 'UT', '801': 'UT',
  '276': 'VA', '434': 'VA', '540': 'VA', '571': 'VA', '703': 'VA', '757': 'VA', '804': 'VA',
  '206': 'WA', '253': 'WA', '360': 'WA', '425': 'WA', '509': 'WA', '564': 'WA',
  '202': 'DC',
  '262': 'WI', '414': 'WI', '534': 'WI', '608': 'WI', '715': 'WI', '920': 'WI'
};

const STATE_NAMES = {
  'AZ': 'Arizona', 'CA': 'California', 'CO': 'Colorado', 'FL': 'Florida',
  'GA': 'Georgia', 'IL': 'Illinois', 'IN': 'Indiana', 'LA': 'Louisiana',
  'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota',
  'MO': 'Missouri', 'NJ': 'New Jersey', 'NY': 'New York', 'NC': 'North Carolina',
  'OH': 'Ohio', 'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania',
  'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VA': 'Virginia',
  'WA': 'Washington', 'DC': 'Washington DC', 'WI': 'Wisconsin'
};

const TEAM_MARKETS = {
  'atlanta hawks': ['GA'], 'boston celtics': ['MA'], 'brooklyn nets': ['NY', 'NJ'],
  'charlotte hornets': ['NC'], 'chicago bulls': ['IL'], 'cleveland cavaliers': ['OH'],
  'dallas mavericks': ['TX'], 'denver nuggets': ['CO'], 'detroit pistons': ['MI'],
  'golden state warriors': ['CA'], 'houston rockets': ['TX'], 'indiana pacers': ['IN'],
  'la clippers': ['CA'], 'los angeles clippers': ['CA'], 'los angeles lakers': ['CA'],
  'la lakers': ['CA'], 'memphis grizzlies': ['TN'], 'miami heat': ['FL'],
  'milwaukee bucks': ['WI'], 'minnesota timberwolves': ['MN'], 'new orleans pelicans': ['LA'],
  'new york knicks': ['NY', 'NJ'], 'oklahoma city thunder': ['OK'], 'orlando magic': ['FL'],
  'philadelphia 76ers': ['PA', 'NJ'], 'phoenix suns': ['AZ'], 'portland trail blazers': ['OR'],
  'sacramento kings': ['CA'], 'san antonio spurs': ['TX'], 'toronto raptors': ['ON'],
  'utah jazz': ['UT'], 'washington wizards': ['DC', 'MD', 'VA'],
  'arizona cardinals': ['AZ'], 'atlanta falcons': ['GA'], 'baltimore ravens': ['MD'],
  'buffalo bills': ['NY'], 'carolina panthers': ['NC'], 'chicago bears': ['IL'],
  'cincinnati bengals': ['OH'], 'cleveland browns': ['OH'], 'dallas cowboys': ['TX'],
  'denver broncos': ['CO'], 'detroit lions': ['MI'], 'green bay packers': ['WI'],
  'houston texans': ['TX'], 'indianapolis colts': ['IN'], 'jacksonville jaguars': ['FL'],
  'kansas city chiefs': ['MO'], 'las vegas raiders': ['NV'], 'los angeles chargers': ['CA'],
  'los angeles rams': ['CA'], 'miami dolphins': ['FL'], 'minnesota vikings': ['MN'],
  'new england patriots': ['MA'], 'new orleans saints': ['LA'], 'new york giants': ['NY', 'NJ'],
  'new york jets': ['NY', 'NJ'], 'philadelphia eagles': ['PA', 'NJ'], 'pittsburgh steelers': ['PA'],
  'san francisco 49ers': ['CA'], 'seattle seahawks': ['WA'], 'tampa bay buccaneers': ['FL'],
  'tennessee titans': ['TN'], 'washington commanders': ['DC', 'MD', 'VA'],
  'arizona diamondbacks': ['AZ'], 'atlanta braves': ['GA'], 'baltimore orioles': ['MD'],
  'boston red sox': ['MA'], 'chicago cubs': ['IL'], 'chicago white sox': ['IL'],
  'cincinnati reds': ['OH'], 'cleveland guardians': ['OH'], 'colorado rockies': ['CO'],
  'detroit tigers': ['MI'], 'houston astros': ['TX'], 'kansas city royals': ['MO'],
  'los angeles angels': ['CA'], 'los angeles dodgers': ['CA'], 'miami marlins': ['FL'],
  'milwaukee brewers': ['WI'], 'minnesota twins': ['MN'], 'new york mets': ['NY', 'NJ'],
  'new york yankees': ['NY', 'NJ'], 'oakland athletics': ['CA'], 'philadelphia phillies': ['PA', 'NJ'],
  'pittsburgh pirates': ['PA'], 'san diego padres': ['CA'], 'san francisco giants': ['CA'],
  'seattle mariners': ['WA'], 'st. louis cardinals': ['MO'], 'tampa bay rays': ['FL'],
  'texas rangers': ['TX'], 'toronto blue jays': ['ON'], 'washington nationals': ['DC', 'MD', 'VA'],
  'anaheim ducks': ['CA'], 'arizona coyotes': ['AZ'], 'boston bruins': ['MA'],
  'buffalo sabres': ['NY'], 'calgary flames': ['AB'], 'carolina hurricanes': ['NC'],
  'chicago blackhawks': ['IL'], 'colorado avalanche': ['CO'], 'columbus blue jackets': ['OH'],
  'dallas stars': ['TX'], 'detroit red wings': ['MI'], 'edmonton oilers': ['AB'],
  'florida panthers': ['FL'], 'los angeles kings': ['CA'], 'minnesota wild': ['MN'],
  'montreal canadiens': ['QC'], 'nashville predators': ['TN'], 'new jersey devils': ['NJ'],
  'new york islanders': ['NY'], 'new york rangers': ['NY'], 'ottawa senators': ['ON'],
  'philadelphia flyers': ['PA', 'NJ'], 'pittsburgh penguins': ['PA'], 'san jose sharks': ['CA'],
  'seattle kraken': ['WA'], 'st. louis blues': ['MO'], 'tampa bay lightning': ['FL'],
  'toronto maple leafs': ['ON'], 'vancouver canucks': ['BC'], 'vegas golden knights': ['NV'],
  'washington capitals': ['DC', 'MD', 'VA'], 'winnipeg jets': ['MB']
};

const CLOSER_SLACK_IDS = {
  'jerry': 'U0890N1T1RV',
  'joel': 'U0890N1T1RV',
  'jeremy andrews': 'U07RCLS2Y31',
  'jeremy': 'U07RCLS2Y31',
  'romeo': 'U089F5PGYFM',
  'rommel lucero': 'U089F5PGYFM',
  'rommel': 'U089F5PGYFM',
  'tristan': 'U089F85AH5Y',
  'jorge mendez': 'U09E00AG2AF',
  'jorge': 'U09E00AG2AF',
  'ariel bennett': 'U08LSC9UFU3',
  'ariel': 'U08LSC9UFU3',
  'frances dignos': 'U09EX2GUQF2',
  'frances': 'U09EX2GUQF2',
  'edward salem': 'U0144K906KA',
  'edward': 'U0144K906KA',
  'ed': 'U0144K906KA',
  'elia molinari': 'U08M6BP6X3N',
  'elia': 'U08M6BP6X3N',
  'dayna': 'U05BRER83HT'
};

function getCloserSlackId(closerName) {
  if (!closerName) return null;
  const normalized = closerName.toLowerCase().trim();
  return CLOSER_SLACK_IDS[normalized] || null;
}

function getStateFromAreaCode(areaCode) {
  return AREA_CODE_TO_STATE[areaCode] || null;
}

function getAreaCodeFromPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 10) {
    return digits.startsWith('1') && digits.length === 11
      ? digits.substring(1, 4)
      : digits.substring(0, 3);
  }
  return null;
}

function doesAreaCodeMatchTeam(areaCode, teamName) {
  const state = getStateFromAreaCode(areaCode);
  if (!state) return { matches: false, state: null, stateName: null };

  const normalizedTeam = teamName.toLowerCase().trim();
  const teamStates = TEAM_MARKETS[normalizedTeam];

  if (!teamStates) return { matches: false, state, stateName: STATE_NAMES[state] || state };

  return {
    matches: teamStates.includes(state),
    state,
    stateName: STATE_NAMES[state] || state
  };
}

/**
 * Search Associates board by email to find SS mobile number
 * @param {string} email - Email to search for
 * @returns {Promise<{name: string, phone: string, email: string}|null>}
 */
async function searchAssociateByEmail(email) {
  const normalizedEmail = email.toLowerCase().trim();

  console.log(`[MONDAY] Searching for email: ${normalizedEmail}`);

  const query = `
    query ($boardId: [ID!]!) {
      boards(ids: $boardId) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  const result = await mondayQuery(query, { boardId: [ASSOCIATES_BOARD_ID] });
  const items = result.boards[0]?.items_page?.items || [];

  console.log(`[MONDAY] Found ${items.length} associates`);

  // Log column IDs from first item to debug
  if (items.length > 0) {
    const colIds = items[0].column_values.map(c => c.id);
    console.log(`[MONDAY] Column IDs: ${colIds.join(', ')}`);
  }

  for (const item of items) {
    let phone = null;
    let itemEmail = null;

    for (const col of item.column_values) {
      // Use ss_mobile for phone (ss_phone is mirrored/blank)
      if (col.id === 'ss_mobile' && col.text && col.text !== 'null' && col.text.length >= 10) {
        phone = col.text;
      }
      // Use ss_email for email
      if (col.id === 'ss_email' && col.text && col.text !== 'null' && col.text.includes('@')) {
        itemEmail = col.text;
      }
    }

    // Debug: log associates that have emails
    if (itemEmail && itemEmail.toLowerCase().includes(normalizedEmail.split('@')[0])) {
      console.log(`[MONDAY] Potential match: ${item.name}, email=${itemEmail}, phone=${phone}`);
    }

    if (itemEmail && itemEmail.toLowerCase().trim() === normalizedEmail && phone) {
      console.log(`[MONDAY] Found match: ${item.name}, phone=${phone}`);
      return {
        name: item.name,
        phone: phone.replace(/\D/g, ''),
        email: itemEmail
      };
    }
  }

  console.log(`[MONDAY] No match found for ${normalizedEmail}`);
  return null;
}

/**
 * Search External Emails board by email (item name) to find linked phone number
 * This board is for non-associate emails (external TM accounts)
 * @param {string} email - Email to search for
 * @returns {Promise<{name: string, phone: string, email: string}|null>}
 */
async function searchExternalByEmail(email) {
  const normalizedEmail = email.toLowerCase().trim();

  console.log(`[MONDAY] Searching External Emails board for: ${normalizedEmail}`);

  const query = `
    query ($boardId: [ID!]!) {
      boards(ids: $boardId) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  const result = await mondayQuery(query, { boardId: [EXTERNAL_EMAILS_BOARD_ID] });
  const items = result.boards[0]?.items_page?.items || [];

  console.log(`[MONDAY] Found ${items.length} external email entries`);

  // Log column IDs from first item to debug
  if (items.length > 0) {
    const colIds = items[0].column_values.map(c => `${c.id}=${c.text || '(empty)'}`);
    console.log(`[MONDAY] External board columns: ${colIds.join(', ')}`);
  }

  for (const item of items) {
    // Email is stored in item.name (the "Tm account" column)
    const itemEmail = item.name;

    if (itemEmail && itemEmail.toLowerCase().trim() === normalizedEmail) {
      // Find phone column - look for columns with 'phone' in the ID
      let phone = null;
      for (const col of item.column_values) {
        const colIdLower = col.id.toLowerCase();
        if ((colIdLower.includes('phone') || colIdLower.includes('ss_phone')) &&
            col.text && col.text !== 'null' && col.text.length >= 10) {
          phone = col.text;
          break;
        }
      }

      if (phone) {
        console.log(`[MONDAY] Found external match: ${itemEmail}, phone=${phone}`);
        return {
          name: itemEmail, // Use email as name since this is external
          phone: phone.replace(/\D/g, ''),
          email: itemEmail
        };
      } else {
        console.log(`[MONDAY] Found email ${itemEmail} but no phone number`);
      }
    }
  }

  console.log(`[MONDAY] No external match found for ${normalizedEmail}`);
  return null;
}

module.exports = {
  lookupDealsByPhone,
  getAreaCodeFromPhone,
  getStateFromAreaCode,
  doesAreaCodeMatchTeam,
  getCloserSlackId,
  searchAssociateByEmail,
  searchExternalByEmail,
  STATE_NAMES
};
