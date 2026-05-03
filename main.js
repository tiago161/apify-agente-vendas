import { Actor } from 'apify'
import { chromium } from 'playwright'
import axios from 'axios'

await Actor.init()

const input = await Actor.getInput()
const {
  searchQueries      = ['escola particular'],
  locations          = ['São Paulo, SP'],
  sources            = ['google_maps'],
  maxResultsPerQuery = 20,
  webhookUrl         = '',
  webhookSecret      = '',
  linkedinCookie     = '',
  excludeKeywords    = [],   // ex: ['supermercado', 'mercado', 'varejão', 'atacado']
} = input ?? {}

const allLeads = []
const seenCompanies = new Set()

function isExcluded(text) {
  if (!text || excludeKeywords.length === 0) return false
  const lower = text.toLowerCase()
  return excludeKeywords.some(kw => lower.includes(kw.toLowerCase()))
}

function addLead(lead) {
  if (isExcluded(lead.companyName) || isExcluded(lead.category)) {
    console.log(`   ⏭ Ignorado (filtro): ${lead.companyName}`)
    return
  }
  const key = lead.companyName.trim().toLowerCase()
  if (seenCompanies.has(key)) return
  seenCompanies.add(key)
  allLeads.push(lead)
}

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

function extractEmails(html) {
  return [...new Set((html.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [])
    .filter(e => !/noreply|example|seudominio|@2x|\.png|\.jpg/i.test(e)))]
}

function extractCnpj(html) {
  const m = html.match(/\d{2}[.\-]?\d{3}[.\-]?\d{3}[\/\-]?\d{4}[.\-]?\d{2}/)
  if (!m) return null
  const digits = m[0].replace(/\D/g, '')
  return digits.length === 14 ? digits : null
}

// ── Enriquece via site da empresa ─────────────────────────
async function enrichFromWebsite(browser, lead) {
  if (!lead.website) return null
  const page = await browser.newPage()
  try {
    await page.goto(lead.website, { waitUntil: 'load', timeout: 15_000 })
    const html = await page.content()

    // Emails e CNPJ na home
    const homeEmails = extractEmails(html)
    const cnpj = extractCnpj(html)

    // Tenta páginas de contato/sobre/equipe
    const contactUrls = await page.$$eval('a[href]', (els, base) =>
      els.map(el => el.href)
        .filter(h => h.startsWith(base) && /contato|fale|contact|sobre|equipe|time|about/i.test(h))
        .slice(0, 3),
      new URL(lead.website).origin
    ).catch(() => [])

    const extraEmails = []
    for (const url of contactUrls) {
      const sub = await browser.newPage()
      try {
        await sub.goto(url, { waitUntil: 'load', timeout: 10_000 })
        extraEmails.push(...extractEmails(await sub.content()))
      } catch { /* ignora */ } finally { await sub.close() }
    }

    const allEmails = [...new Set([...homeEmails, ...extraEmails])]

    // Se não tem decisor ainda, cria um com o e-mail encontrado
    if (allEmails.length > 0 && lead.decisionMakers.length === 0) {
      lead.decisionMakers.push({
        name:          'Contato ' + lead.companyName,
        email:         allEmails[0],
        role:          'Contato do Site',
        phonePersonal: null,
      })
    } else if (allEmails.length > 0) {
      // Completa e-mail de decisor existente se estiver vazio
      lead.decisionMakers.forEach(dm => { if (!dm.email) dm.email = allEmails[0] })
    }

    if (cnpj) lead.cnpj = cnpj
    console.log(`   🌐 Site: ${allEmails.length} email(s), CNPJ: ${cnpj ?? 'não encontrado'}`)
    return cnpj
  } catch (err) {
    console.warn(`   🌐 Erro no site ${lead.website}: ${err.message}`)
    return null
  } finally {
    await page.close()
  }
}

// ── Enriquece via CNPJ (BrasilAPI — sem auth) ─────────────
async function enrichFromCnpj(lead, cnpj) {
  if (!cnpj) return
  try {
    const { data } = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { timeout: 12_000 })
    const socios = data.qsa ?? []
    for (const socio of socios.slice(0, 3)) {
      if (!socio.nome_socio) continue
      const already = lead.decisionMakers.find(dm =>
        dm.name.toLowerCase().includes(socio.nome_socio.toLowerCase())
      )
      if (!already) {
        lead.decisionMakers.push({
          name:          socio.nome_socio,
          role:          socio.qualificacao_socio ?? 'Sócio/Administrador',
          email:         null,
          phonePersonal: null,
        })
      }
    }
    if (socios.length > 0) console.log(`   🏛️ CNPJ: ${socios.length} sócio(s) encontrado(s)`)
  } catch (err) {
    if (err?.response?.status !== 404) console.warn(`   🏛️ CNPJ ${cnpj}: ${err.message}`)
  }
}

// ── Google Maps via Playwright + Crawlee (stealth) ───────
async function scrapeGoogleMaps(browser) {
  for (const query of searchQueries) {
    for (const location of locations) {
      console.log(`\n🗺️  Google Maps: "${query}" em "${location}"`)

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport:  { width: 1280, height: 800 },
        locale:    'pt-BR',
        timezoneId: 'America/Sao_Paulo',
      })
      const page = await context.newPage()

      // Remove sinais de automação
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] })
      })

      try {
        const url = `https://www.google.com/maps/search/${encodeURIComponent(`${query} ${location}`)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 })

        // Aceita cookies/consent se aparecer
        await page.click('button[aria-label*="Accept"], button[aria-label*="Aceitar"], form[action*="consent"] button', { timeout: 4_000 }).catch(() => null)
        await page.waitForTimeout(2500)

        // Aguarda o feed de resultados
        await page.waitForSelector('[role="feed"]', { timeout: 25_000 }).catch(() => null)
        await page.waitForTimeout(1500)

        // Rola para carregar mais
        for (let i = 0; i < Math.ceil(maxResultsPerQuery / 5); i++) {
          await page.evaluate(() => document.querySelector('[role="feed"]')?.scrollBy(0, 1200))
          await page.waitForTimeout(800)
        }

        // Tenta múltiplos seletores de card
        let cards = []
        for (const sel of ['.Nv2PK', '[role="article"]', '.hfpxzc']) {
          cards = await page.$$(sel)
          if (cards.length > 0) break
        }
        cards = cards.slice(0, maxResultsPerQuery)
        console.log(`   Encontrados ${cards.length} resultado(s)`)

        for (const card of cards) {
          try {
            // Nome extraído diretamente do card (evita h1 "Results")
            const name = await card.$eval('.qBF1Pd',        el => el.textContent?.trim()).catch(() => null)
                      ?? await card.$eval('.fontHeadlineSmall', el => el.textContent?.trim()).catch(() => null)
                      ?? await card.$eval('[aria-label]',    el => el.getAttribute('aria-label')).catch(() => null)

            if (!name || name === 'Results') continue

            await card.click()
            await page.waitForTimeout(1200)

            const phone   = await page.$eval('[data-item-id^="phone:"]', el => el.getAttribute('data-item-id')?.replace('phone:', '') ?? null).catch(() => null)
            const website = await safeAttr(page, 'a[data-item-id="authority"]', 'href')
            const address = await safeText(page, '[data-item-id="address"]')
            const cat     = await safeText(page, 'button[jsaction*="category"]')

            addLead({ companyName: name, companyPhone: phone?.trim() ?? null, website: website ?? null, category: cat ?? null, address: address ?? null, location, source: 'google_maps', decisionMakers: [] })
            console.log(`   ✓ ${name}`)
          } catch (err) {
            console.warn('   Aviso card:', err.message)
          }
        }
      } catch (err) {
        console.error(`   Erro Google Maps: ${err.message}`)
      } finally {
        await page.close()
        await context.close()
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
      await context.addCookies([{ name: 'li_at', value: linkedinCookie, domain: '.linkedin.com', path: '/' }])
      const page = await context.newPage()

      try {
        const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}`
        await page.goto(url, { waitUntil: 'networkidle', timeout: 40_000 })
        await page.waitForTimeout(2000)

        const cards = (await page.$$('.entity-result__item')).slice(0, maxResultsPerQuery)
        console.log(`   Encontrados ${cards.length} perfis`)

        for (const card of cards) {
          try {
            const name        = await card.$eval('.entity-result__title-text a span[aria-hidden="true"]', el => el.textContent?.trim()).catch(() => '')
            const role        = await card.$eval('.entity-result__primary-subtitle',   el => el.textContent?.trim()).catch(() => null)
            const company     = await card.$eval('.entity-result__secondary-subtitle', el => el.textContent?.trim()).catch(() => null)
            const linkedinUrl = await card.$eval('.entity-result__title-text a',       el => el.getAttribute('href')).catch(() => null)

            if (name) {
              addLead({
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
            addLead({
              companyName:    name,
              companyPhone:   phoneMatch?.[1]?.trim() ?? null,
              source:         'instagram',
              location:       locations[0] ?? '',
              decisionMakers: emailMatch ? [{ name, email: emailMatch[0], role: null, phonePersonal: phoneMatch?.[1]?.trim() ?? null }] : [],
            })
          }
        } catch (err) {
          console.warn('   Aviso Instagram:', err.message)
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
console.log(`   Filtros: ${excludeKeywords.length ? excludeKeywords.join(', ') : 'nenhum'}`)
console.log(`   Máx/busca: ${maxResultsPerQuery}\n`)

const browser = await chromium.launch({ headless: true })
try {
  if (sources.includes('google_maps')) await scrapeGoogleMaps(browser)
  if (sources.includes('linkedin'))    await scrapeLinkedIn(browser)
  if (sources.includes('instagram'))   await scrapeInstagram(browser)

  const leadsWithSite = allLeads.filter(l => l.website)
  if (leadsWithSite.length > 0) {
    console.log(`\n🔍 Enriquecendo ${leadsWithSite.length} lead(s) com dados do site e CNPJ...`)
    for (const lead of leadsWithSite) {
      const cnpj = await enrichFromWebsite(browser, lead)
      await enrichFromCnpj(lead, cnpj ?? lead.cnpj ?? null)
    }
  }
} finally {
  await browser.close()
}

console.log(`\n📊 Total de leads coletados: ${allLeads.length}`)
await sendToCrm(allLeads)
await Actor.pushData(allLeads)
await Actor.exit()
