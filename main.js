import { Actor } from 'apify'
import { chromium } from 'playwright'
import axios from 'axios'

await Actor.init()

const input = await Actor.getInput()
const {
  searchQueries    = ['escola particular'],
  locations        = ['São Paulo, SP'],
  sources          = ['google_maps'],
  maxResultsPerQuery = 20,
  webhookUrl       = '',
  webhookSecret    = '',
  linkedinCookie   = '',
} = input ?? {}

const allLeads = []

async function sendToCrm(leads) {
  if (!webhookUrl || leads.length === 0) return
  try {
    const url = webhookSecret ? `${webhookUrl}?secret=${webhookSecret}` : webhookUrl
    await axios.post(url, { leads }, { timeout: 30_000 })
    console.log(`✅ ${leads.length} lead(s) enviados ao CRM`)
  } catch (err) {
    console.error('❌ Erro ao enviar leads ao CRM:', err?.response?.data ?? err.message)
  }
}

// ── Helpers ──────────────────────────────────────────────
async function safeText(page, selector) {
  return page.$eval(selector, el => el.textContent?.trim() ?? '').catch(() => null)
}

async function safeAttr(page, selector, attr) {
  return page.$eval(selector, (el, a) => el.getAttribute(a), attr).catch(() => null)
}

// ── Google Maps ──────────────────────────────────────────
async function scrapeGoogleMaps(browser) {
  for (const query of searchQueries) {
    for (const location of locations) {
      console.log(`\n🗺️  Google Maps: "${query}" em "${location}"`)
      const page = await browser.newPage()

      try {
        const url = `https://www.google.com/maps/search/${encodeURIComponent(`${query} ${location}`)}`

        // networkidle nunca termina no Maps — usar load + waitForSelector
        await page.goto(url, { waitUntil: 'load', timeout: 40_000 })

        // Aguarda o feed de resultados aparecer
        await page.waitForSelector('[role="feed"]', { timeout: 20_000 }).catch(() => null)
        await page.waitForTimeout(2000)

        // Rola o feed para carregar mais resultados
        const scrolls = Math.ceil(maxResultsPerQuery / 5)
        for (let i = 0; i < scrolls; i++) {
          await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]')
            if (feed) feed.scrollBy(0, 1200)
          })
          await page.waitForTimeout(1000)
        }

        // Seletores atuais do Google Maps (2024+)
        const cardSelectors = ['.Nv2PK', '[role="article"]', '.hfpxzc']
        let cards = []
        for (const sel of cardSelectors) {
          cards = await page.$$(sel)
          if (cards.length > 0) break
        }
        cards = cards.slice(0, maxResultsPerQuery)
        console.log(`   Encontrados ${cards.length} resultados`)

        for (const card of cards) {
          try {
            await card.click()

            // Aguarda painel lateral carregar
            await page.waitForSelector('h1', { timeout: 8_000 }).catch(() => null)
            await page.waitForTimeout(1000)

            const name = await safeText(page, 'h1')

            // Telefone: atributo data-item-id="phone:+55..."
            const phone = await page.$eval(
              '[data-item-id^="phone:"]',
              el => el.getAttribute('data-item-id')?.replace('phone:', '') ?? null
            ).catch(() => safeText(page, 'button[data-tooltip*="telefone"]'))

            const website  = await safeAttr(page, 'a[data-item-id="authority"]', 'href')
            const category = await safeText(page, '[jsaction*="category"] span')
              ?? await safeText(page, 'button[jsaction*="category"]')
            const address  = await safeText(page, '[data-item-id="address"]')
              ?? await safeText(page, '[aria-label*="Endereço"]')

            if (name) {
              allLeads.push({
                companyName:    name,
                companyPhone:   typeof phone === 'string' ? phone.trim() : null,
                website:        website ?? null,
                category:       category ?? null,
                address:        address ?? null,
                location,
                source:         'google_maps',
                decisionMakers: [],
              })
              console.log(`   ✓ ${name}`)
            }
          } catch (err) {
            console.warn('   Aviso ao processar card:', err.message)
          }
        }
      } catch (err) {
        console.error(`   Erro no Google Maps: ${err.message}`)
      } finally {
        await page.close()
      }
    }
  }
}

// ── LinkedIn ─────────────────────────────────────────────
async function scrapeLinkedIn(browser) {
  if (!linkedinCookie) {
    console.log('⚠️  LinkedIn ignorado: cookie li_at não fornecido')
    return
  }

  for (const query of searchQueries) {
    for (const location of locations) {
      console.log(`\n💼 LinkedIn: "${query}" em "${location}"`)
      const context = await browser.newContext()

      await context.addCookies([{
        name:   'li_at',
        value:  linkedinCookie,
        domain: '.linkedin.com',
        path:   '/',
      }])

      const page = await context.newPage()
      try {
        const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}`
        await page.goto(url, { waitUntil: 'networkidle', timeout: 40_000 })
        await page.waitForTimeout(2000)

        const cards = (await page.$$('.entity-result__item')).slice(0, maxResultsPerQuery)
        console.log(`   Encontrados ${cards.length} perfis`)

        for (const card of cards) {
          try {
            const name       = await card.$eval('.entity-result__title-text a span[aria-hidden="true"]', el => el.textContent?.trim()).catch(() => '')
            const role       = await card.$eval('.entity-result__primary-subtitle',   el => el.textContent?.trim()).catch(() => null)
            const company    = await card.$eval('.entity-result__secondary-subtitle', el => el.textContent?.trim()).catch(() => null)
            const linkedinUrl = await card.$eval('.entity-result__title-text a',       el => el.getAttribute('href')).catch(() => null)

            if (name) {
              allLeads.push({
                companyName:    company ?? query,
                companyPhone:   null,
                source:         'linkedin',
                location,
                decisionMakers: [{ name, role: role ?? null, linkedinUrl: linkedinUrl ?? null, email: null, phonePersonal: null }],
              })
            }
          } catch (err) {
            console.warn('   Aviso ao processar perfil LinkedIn:', err.message)
          }
        }
      } catch (err) {
        console.error(`   Erro no LinkedIn: ${err.message}`)
      } finally {
        await page.close()
        await context.close()
      }
    }
  }
}

// ── Instagram ────────────────────────────────────────────
async function scrapeInstagram(browser) {
  for (const query of searchQueries) {
    const hashtag = query.replace(/\s+/g, '').toLowerCase()
    console.log(`\n📸 Instagram: #${hashtag}`)
    const page = await browser.newPage()

    try {
      await page.goto(`https://www.instagram.com/explore/tags/${hashtag}/`, { waitUntil: 'networkidle', timeout: 40_000 })
      await page.waitForTimeout(2000)

      const postLinks = await page.$$eval('article a[href^="/p/"]', els =>
        [...new Set(els.map(el => el.getAttribute('href')).filter(Boolean))].slice(0, 15)
      )

      const visitedProfiles = new Set()

      for (const postHref of postLinks) {
        if (visitedProfiles.size >= maxResultsPerQuery) break

        try {
          await page.goto(`https://www.instagram.com${postHref}`, { waitUntil: 'networkidle', timeout: 25_000 })
          await page.waitForTimeout(800)

          const profileHref = await page.$eval('a[href^="/"][role="link"]', el => el.getAttribute('href')).catch(() => null)
          if (!profileHref || visitedProfiles.has(profileHref)) continue
          visitedProfiles.add(profileHref)

          await page.goto(`https://www.instagram.com${profileHref}`, { waitUntil: 'networkidle', timeout: 25_000 })
          await page.waitForTimeout(800)

          const name = await safeText(page, 'h1') ?? await safeText(page, 'h2')
          const bio  = await safeText(page, '.-vDIg span') ?? await safeText(page, '._aa_c')

          const phoneMatch = bio?.match(/(\+?[\d\s\-().]{9,})/)
          const emailMatch = bio?.match(/[\w.-]+@[\w.-]+\.\w+/)

          if (name) {
            allLeads.push({
              companyName:    name,
              companyPhone:   phoneMatch?.[1]?.trim() ?? null,
              source:         'instagram',
              location:       locations[0] ?? '',
              decisionMakers: emailMatch ? [{
                name,
                email:         emailMatch[0],
                role:          null,
                phonePersonal: phoneMatch?.[1]?.trim() ?? null,
              }] : [],
            })
          }
        } catch (err) {
          console.warn('   Aviso ao processar post/perfil Instagram:', err.message)
        }
      }
    } catch (err) {
      console.error(`   Erro no Instagram: ${err.message}`)
    } finally {
      await page.close()
    }
  }
}

// ── Main ─────────────────────────────────────────────────
console.log(`\n🚀 Iniciando coleta de leads`)
console.log(`   Termos: ${searchQueries.join(', ')}`)
console.log(`   Locais: ${locations.join(', ')}`)
console.log(`   Fontes: ${sources.join(', ')}`)
console.log(`   Máx/busca: ${maxResultsPerQuery}\n`)

const browser = await chromium.launch({ headless: true })

try {
  if (sources.includes('google_maps')) await scrapeGoogleMaps(browser)
  if (sources.includes('linkedin'))    await scrapeLinkedIn(browser)
  if (sources.includes('instagram'))   await scrapeInstagram(browser)
} finally {
  await browser.close()
}

console.log(`\n📊 Total de leads coletados: ${allLeads.length}`)

await sendToCrm(allLeads)
await Actor.pushData(allLeads)

await Actor.exit()
