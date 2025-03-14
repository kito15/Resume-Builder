// resume_processing.js
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeText, generateHash, calculateSimilarity, calculateKeywordSimilarity } = require('../config/util'); // Fixed from '../config/utils'

// Add new API key reference for Gemini
const geminiApiKey = process.env.GEMINI_API_KEY;
// Simple in-memory cache for LLM responses
const lmCache = new Map();


function countWordsInBullet(text) {
    // Remove extra whitespace and special characters
    const cleaned = text.trim()
        .replace(/[""]/g, '') // Remove smart quotes
        .replace(/[.,!?()]/g, '') // Remove punctuation
        .replace(/\s+/g, ' '); // Normalize spaces
    
    // Count hyphenated words as one word
    const words = cleaned.split(' ')
        .filter(word => word.length > 0)
        .map(word => word.replace(/-/g, '')); // Treat hyphenated words as single
        
    return words.length;
}

function getSectionWordCounts($) {
    const counts = {
        job: { total: 0, bullets: 0 },
        project: { total: 0, bullets: 0 },
        education: { total: 0, bullets: 0 }
    };

    // Count job section bullets
    $('.job-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.job.total += wordCount;
        counts.job.bullets++;
    });

    // Count project section bullets
    $('.project-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.project.total += wordCount;
        counts.project.bullets++;
    });

    // Count education section bullets
    $('.education-details li').each((_, el) => {
        const wordCount = countWordsInBullet($(el).text());
        counts.education.total += wordCount;
        counts.education.bullets++;
    });

    return {
        job: counts.job.bullets > 0 ? Math.round(counts.job.total / counts.job.bullets) : 15,
        project: counts.project.bullets > 0 ? Math.round(counts.project.total / counts.project.bullets) : 15,
        education: counts.education.bullets > 0 ? Math.round(counts.education.total / counts.education.bullets) : 15
    };
}

// Add new function to extract and store original bullets
function extractOriginalBullets($) {
    const originalBullets = {
        job: [],
        project: [],
        education: [],
        unassigned: [] // For any bullets not in a specific section
    };

    // Extract job bullets
    $('.job-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.job.includes(bulletText)) {
                originalBullets.job.push(bulletText);
            }
        });
    });

    // Extract project bullets
    $('.project-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.project.includes(bulletText)) {
                originalBullets.project.push(bulletText);
            }
        });
    });

    // Extract education bullets
    $('.education-details').each((_, section) => {
        $(section).find('li').each((_, bullet) => {
            const bulletText = $(bullet).text().trim();
            if (bulletText && !originalBullets.education.includes(bulletText)) {
                originalBullets.education.push(bulletText);
            }
        });
    });

    return originalBullets;
}

// Add new class to track section-specific bullets
class SectionBulletTracker {
    constructor() {
        this.bulletMap = new Map(); // Maps bullet text to position ID
        this.usedBullets = new Set(); // Tracks all used bullets
    }

    addBullet(bulletText, positionId) {
        this.bulletMap.set(bulletText, positionId);
        this.usedBullets.add(bulletText);
    }

    canUseBulletInSection(bulletText, positionId) {
        // If bullet hasn't been used before, it can be used
        if (!this.bulletMap.has(bulletText)) return true;
        // If bullet has been used, only allow in same position
        return this.bulletMap.get(bulletText) === positionId;
    }

    isUsed(bulletText) {
        return this.usedBullets.has(bulletText);
    }
}

// Add new class to track action verbs
class ActionVerbTracker {
    constructor() {
        this.usedVerbs = new Map(); // Maps section type to Set of used verbs
        this.globalVerbs = new Set(); // Tracks verbs used across all sections
    }

    addVerb(verb, sectionType) {
        verb = verb.toLowerCase();
        if (!this.usedVerbs.has(sectionType)) {
            this.usedVerbs.set(sectionType, new Set());
        }
        this.usedVerbs.get(sectionType).add(verb);
        this.globalVerbs.add(verb);
    }

    isVerbUsedInSection(verb, sectionType) {
        verb = verb.toLowerCase();
        return this.usedVerbs.get(sectionType)?.has(verb) || false;
    }

    isVerbUsedGlobally(verb) {
        return this.globalVerbs.has(verb.toLowerCase());
    }

    clearSection(sectionType) {
        this.usedVerbs.set(sectionType, new Set());
    }
}

// Add function to get first verb from bullet point
function getFirstVerb(bulletText) {
    return bulletText.trim().split(/\s+/)[0].toLowerCase();
}

// Add function to shuffle bullets with verb checking
function shuffleBulletsWithVerbCheck(bullets, sectionType, verbTracker) {
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
        // Shuffle the array
        bullets = shuffleArray([...bullets]);
        
        // Check if the arrangement is valid
        let isValid = true;
        let previousVerb = '';
        
        for (let i = 0; i < bullets.length; i++) {
            const currentVerb = getFirstVerb(bullets[i]);
            
            // Check if verb is same as previous bullet or already used as first verb in another section
            if (currentVerb === previousVerb || 
                (i === 0 && verbTracker.isVerbUsedGlobally(currentVerb))) {
                isValid = false;
                break;
            }
            
            previousVerb = currentVerb;
        }
        
        if (isValid) {
            // Add first verb to tracker
            if (bullets.length > 0) {
                verbTracker.addVerb(getFirstVerb(bullets[0]), sectionType);
            }
            return bullets;
        }
        
        attempts++;
    }
    
    return bullets; // Return last shuffle if we couldn't find perfect arrangement
}

// Add BulletCache class for efficient bullet point management
class BulletCache {
    constructor() {
        this.cache = new Map();
        this.positionPools = new Map(); // Maps position IDs to bullet pools
        this.sectionPools = {
            job: new Set(),
            project: new Set(),
            education: new Set()
        };
        this.targetBulletCounts = {
            job: 7,
            project: 6,
            education: 5
        };
    }

    async generateAllBullets($, keywords, context, wordLimit) {
        const sections = ['job', 'project', 'education'];
        const cacheKey = `${keywords.join(',')}_${context}`;

        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        const allBullets = {};
        const promises = sections.map(async (section) => {
            const targetCount = this.targetBulletCounts[section];
            const bullets = await generateBullets(
                'generate',
                null,
                keywords,
                `for ${section} experience`,
                wordLimit
            );
            allBullets[section] = bullets.slice(0, targetCount);
            bullets.forEach(bullet => this.sectionPools[section].add(bullet));
        });

        await Promise.all(promises);
        this.cache.set(cacheKey, allBullets);
        return allBullets;
    }

    getBulletsForSection(section, count) {
        return Array.from(this.sectionPools[section]).slice(0, count);
    }

    getBulletsForPosition(positionId, count) {
        if (!this.positionPools.has(positionId)) {
            // If no specific pool exists for this position, create one
            this.positionPools.set(positionId, new Set());
            
            // Get section type (job, project, education) from position ID
            const sectionType = positionId.split('-')[0];
            
            // Copy some bullets from the section pool to this position pool
            if (this.sectionPools[sectionType]) {
                const sectionBullets = Array.from(this.sectionPools[sectionType]);
                sectionBullets.forEach(bullet => {
                    this.positionPools.get(positionId).add(bullet);
                });
            }
        }
        
        return Array.from(this.positionPools.get(positionId)).slice(0, count);
    }

    addBulletToSection(bullet, section) {
        this.sectionPools[section].add(bullet);
    }

    addBulletToPosition(bullet, positionId) {
        if (!this.positionPools.has(positionId)) {
            this.positionPools.set(positionId, new Set());
        }
        this.positionPools.get(positionId).add(bullet);
        
        // Also add to section pool for backward compatibility
        const sectionType = positionId.split('-')[0];
        if (this.sectionPools[sectionType]) {
            this.sectionPools[sectionType].add(bullet);
        }
    }

    clear() {
        this.cache.clear();
        this.positionPools.clear();
        Object.values(this.sectionPools).forEach(pool => pool.clear());
    }
}

async function generateBullets(mode, existingBullets, keywords, context, wordLimit) {
    let prompt;
    const basePrompt = `Expert resume writer: Transform bullets into compelling achievements with quantifiable results while naturally incorporating ALL keywords.

CRITICAL REQUIREMENTS:
1) YOU MUST PREFIX EVERY BULLET POINT WITH ">>" - THIS IS ABSOLUTELY REQUIRED
2) Preserve EXACT numbers, metrics, and achievements (e.g., "increased efficiency by 45%" must stay exactly as "45%")
3) ENHANCE bullets with specific metrics/numbers where missing - add quantified impact (%, $, time saved, etc.)
4) Integrate ALL keywords (${keywords}) naturally into the flow
5) Each bullet starts with ">>" followed by a powerful action verb (avoid weak verbs like "helped", "worked on")
6) Keep within ${wordLimit} words unless preserving details requires more
7) Maintain consistent date formatting and chronological ordering
8) NO buzzwords, clichés, or generic corporate speak (avoid: "synergy", "thinking outside the box", etc.)
9) Ensure each bullet in a section uses a DIFFERENT strong action verb

STRUCTURE (implicit, not explicit):
- BEGIN EACH BULLET POINT WITH THE ">>" PREFIX - THIS IS MANDATORY
- Begin each bullet with powerful, specific action verb (e.g., "Engineered" not "Created", "Spearheaded" not "Led")
- Weave in context with clear, concise language
- Integrate keywords seamlessly without awkward placement
- End with concrete, quantifiable results showing impact

EXAMPLES:
Original: "Managed database optimization project"
Keywords: "Python, AWS"
✓ CORRECT: ">>Engineered database optimization system using Python scripts and AWS infrastructure, reducing query latency by 60% and cutting storage costs $12K annually"
✗ WRONG: "Engineered database optimization system using Python scripts and AWS infrastructure, reducing query latency by 60%" (missing ">>" prefix)
✗ WRONG: "Used Python and AWS to manage databases" (lacks impact, weak verb, missing ">>" prefix)
✗ WRONG: ">>Managed database project (Python, AWS)" (artificial keyword placement, no metrics)

Original: "Led team of 5 developers, increased productivity"
Keywords: "agile, JavaScript"
✓ CORRECT: ">>Orchestrated 5-person agile development team delivering JavaScript applications, driving 30% productivity increase and reducing sprint cycle time by 4 days"
✗ WRONG: "Orchestrated 5-person agile development team" (missing ">>" prefix)
✗ WRONG: ">>Leveraged agile and JavaScript to synergize team dynamics" (buzzwords, no metrics)

VALIDATION:
1. VERIFY EVERY BULLET STARTS WITH ">>" PREFIX - THIS IS CRUCIAL
2. Verify ALL bullets contain specific numbers/metrics showing impact
3. Confirm ALL keywords appear naturally within context
4. Ensure each bullet starts with a unique, powerful action verb
5. Check for ">>" prefix and proper formatting`;

    if (mode === 'tailor') {
        prompt = `${basePrompt}

INPUT BULLETS TO ENHANCE (integrate ALL keywords naturally):
${(existingBullets || []).join('\n')}

IMPORTANT: EVERY GENERATED BULLET MUST START WITH THE ">>" PREFIX! No exceptions.`;
    } else {
        prompt = `${basePrompt}

Generate 4-5 achievement-focused bullets ${context} with concrete metrics and varied action verbs.

IMPORTANT: EVERY GENERATED BULLET MUST START WITH THE ">>" PREFIX! No exceptions.`;
    }

    // Maximum retry attempts
    const MAX_RETRIES = 3;
    let retries = 0;
    let bullets = [];

    while (retries < MAX_RETRIES && bullets.length < 3) {
        try {
            console.log(`Attempt ${retries + 1} to generate bullets for ${context}`);
            
            // Add retry context to prompt if this is a retry
            const retryPrompt = retries > 0 ? 
                `${prompt}\n\nThis is retry #${retries+1}. Previous attempts didn't produce enough properly formatted bullets. REMEMBER: EVERY BULLET MUST START WITH ">>" - this is critical for processing.` : 
                prompt;
            
            // Call the language model
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${geminiApiKey}`,
                {
                    system_instruction: {
                        parts: [{
                            text: "You are a specialized resume optimization AI focused on seamlessly integrating keywords while preserving achievement metrics. Your MOST IMPORTANT requirement is to prefix every bullet point with >>."
                        }]
                    },
                    contents: [{
                        parts: [{
                            text: retryPrompt
                        }]
                    }],
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 2000,
                        topP: 0.9,
                        topK: 40
                    },
                    safetySettings: [{
                        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                        threshold: "BLOCK_ONLY_HIGH"
                    }]
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            // Parse response
            const content = response.data.candidates[0].content.parts[0].text;
            
            // Log the raw content for debugging
            console.log(`Raw LLM response for ${context} (attempt ${retries + 1}):`);
            console.log(content.substring(0, 200) + "..."); // Log first 200 chars for debugging
            
            // Match lines starting with >>
            const matched = content.match(/^\>\>(.+)$/gm) || [];
            console.log(`Found ${matched.length} properly formatted bullets`);
            
            // If we didn't find any properly formatted bullets, try a simpler matching approach
            let processedBullets = [];
            if (matched.length === 0) {
                // Try to find bullets with a more lenient approach - looking for any paragraph that appears to be a bullet
                console.log("No >> prefixed bullets found, trying alternative extraction...");
                const paragraphs = content.split(/\n+/).filter(p => p.trim().length > 10);
                
                // Format them properly
                processedBullets = paragraphs.map(p => {
                    // Clean up the paragraph and add proper prefix
                    const cleaned = p.trim()
                        .replace(/^[-•*]\s*/, '') // Remove existing bullet markers
                        .replace(/^\d+\.\s*/, '') // Remove numbering
                        .replace(/^[A-Z][a-z]+:?\s+/, ''); // Remove potential labels
                    
                    // Only include if it looks like a valid bullet (starts with an action verb)
                    const words = cleaned.split(/\s+/);
                    if (words.length > 3 && words[0].match(/^[A-Z][a-z]+ed$|^[A-Z][a-z]+d$/)) {
                        return cleaned;
                    }
                    return null;
                }).filter(Boolean);
                
                console.log(`Alternative extraction found ${processedBullets.length} potential bullets`);
            } else {
                // Process the correctly formatted bullets
                processedBullets = matched.map(bp =>
                    bp.replace(/^>>\s*/, '')
                      .replace(/\*\*/g, '')
                      .replace(/\s*\([^)]*\)$/, '') // Remove any trailing parenthesis and enclosed keywords
                );
            }
            
            // Add these bullets to our collection
            bullets = [...bullets, ...processedBullets];
            
            // If we have enough bullets, break out of the loop
            if (bullets.length >= 3) {
                break;
            }
            
            // Otherwise, try again
            retries++;
            
        } catch (error) {
            console.error('Error generating bullets (attempt ' + (retries + 1) + '):', error.response?.data || error.message);
            retries++;
            
            // Short delay before retry
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    // Log results
    console.log(`Final bullet count for ${context}: ${bullets.length}`);
    
    // Return what we have, even if it's not enough
    return bullets;
}

// Add function to extract position IDs from the HTML
function generatePositionIds($) {
    const positionIds = {
        job: [],
        project: [],
        education: []
    };

    // Generate IDs for job positions
    $('.job-details').each((index, section) => {
        const company = $(section).find('.company-name').text().trim();
        const position = $(section).find('.position-title').text().trim();
        const id = `job-${index}-${company.replace(/\s+/g, '-').toLowerCase()}`;
        positionIds.job.push(id);
    });

    // Generate IDs for projects
    $('.project-details').each((index, section) => {
        const project = $(section).find('.project-title').text().trim();
        const id = `project-${index}-${project.replace(/\s+/g, '-').toLowerCase()}`;
        positionIds.project.push(id);
    });

    // Generate IDs for education
    $('.education-details').each((index, section) => {
        const school = $(section).find('.school-name').text().trim();
        const id = `education-${index}-${school.replace(/\s+/g, '-').toLowerCase()}`;
        positionIds.education.push(id);
    });

    return positionIds;
}

// Update adjustSectionBullets to use BulletCache and position IDs
async function adjustSectionBullets($, selector, targetCount, sectionType, bulletTracker, keywords, context, bulletCache, positionIds) {
    const sections = $(selector);
    sections.each((index, section) => {
        const bulletList = $(section).find('ul');
        const bullets = bulletList.find('li');
        const currentCount = bullets.length;
        const positionId = positionIds[sectionType][index] || `${sectionType}-${index}`;

        if (currentCount > targetCount) {
            // Remove excess bullets from the end
            bullets.slice(targetCount).remove();
        } else if (currentCount < targetCount) {
            const cachedBullets = bulletCache.getBulletsForPosition(positionId, targetCount - currentCount);
            const validBullets = cachedBullets
                .filter(bp => !bulletTracker.isUsed(bp))
                .slice(0, targetCount - currentCount);

            validBullets.forEach(bullet => {
                bulletTracker.addBullet(bullet, positionId);
                bulletList.append(`<li>${bullet}</li>`);
            });
        }
    });
}

async function ensureBulletRange(bulletPoints, usedBullets, generateFn, minCount, maxCount) {
    let attempts = 0;

    // Try to get more bullet points if we don't have enough
    while (bulletPoints.length < minCount && attempts < 3) {
        try {
            const newPoints = (await generateFn()).filter(bp => !usedBullets.has(bp));
            bulletPoints = bulletPoints.concat(newPoints);
        } catch (error) {
            console.error('Error generating additional bullets:', error);
        }
        attempts++;
    }

    // Return what we have, up to maxCount
    return bulletPoints.slice(0, maxCount);
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function checkPageHeight(page) {
    return await page.evaluate(() => {
        const body = document.body;
        const html = document.documentElement;
        return Math.max(
            body.scrollHeight,
            body.offsetHeight,
            html.clientHeight,
            html.scrollHeight,
            html.offsetHeight
        );
    });
}

async function convertHtmlToPdf(htmlContent) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    const customCSS = `
        @page {
            size: Letter;
            margin: 0.3in;
        }
        body {
            font-family: 'Calibri', 'Arial', sans-serif;
            font-size: 12px;
            line-height: 1.2;
            margin: 0;
            padding: 0;
            color: #000;
            max-width: 100%;
        }
        
        /* Header Styling */
        h1 {
            text-align: center;
            margin: 0 0 2px 0;
            font-size: 24px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #000;
        }
        
        .contact-info {
            text-align: center;
            margin-bottom: 8px;
            width: 100%;
            display: flex;
            justify-content: center;
            gap: 4px;
            align-items: center;
            color: #000;
        }
        
        /* Keep only the separator in gray */
        .contact-info > *:not(:last-child)::after {
            content: "|";
            margin-left: 4px;
            font-size: 11px;
            color: #333;
        }
        
        /* Section Styling */
        h2 {
            text-transform: uppercase;
            border-bottom: 1px solid #000;
            margin: 0 0 4px 0;
            padding: 0;
            font-size: 14px;
            font-weight: bold;
            letter-spacing: 0;
            color: #000;
        }
        
        /* Experience Section */
        .job-details, .project-details, .education-details {
            margin-bottom: 6px;
        }
        
        .position-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 1px;
            flex-wrap: nowrap;
            width: 100%;
        }
        
        .position-left {
            display: flex;
            gap: 4px;
            align-items: baseline;
            flex: 1;
        }
        
        .company-name {
            font-weight: bold;
            font-style: italic;
            margin-right: 4px;
        }
        
        .location {
            font-style: normal;
            margin-left: auto;
            padding-right: 4px;
        }
        
        /* Bullet Points */
        ul {
            margin: 0;
            padding-left: 12px;
            margin-bottom: 4px;
        }
        
        li {
            margin-bottom: 0;
            padding-left: 0;
            line-height: 1.25;
            text-align: justify;
        }
        
        /* Links */
        a {
            color: #000;
            text-decoration: none;
        }
        
        /* Date Styling */
        .date {
            font-style: italic;
            white-space: nowrap;
            min-width: fit-content;
        }
        
        /* Skills Section */
        .skills-section {
            margin-bottom: 6px;
        }
        
        .skills-section p {
            margin: 1px 0;
            line-height: 1.25;
        }
        
        /* Adjust spacing between sections */
        section {
            margin-bottom: 8px;
        }
        
        /* Project Section */
        .project-title {
            font-weight: bold;
            font-style: italic;
        }
        
        /* Education Section */
        .degree {
            font-style: italic;
        }
        
        /* Position Title */
        .position-title {
            font-style: italic;
            font-weight: normal;
        }
    `;

    await page.setContent(htmlContent);
    await page.evaluate((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }, customCSS);

    // Check page height
    const height = await checkPageHeight(page);
    const MAX_HEIGHT = 1056; // 11 inches * 96 DPI
    
    const pdfBuffer = await page.pdf({
        format: 'Letter',
        printBackground: true,
        preferCSSPageSize: true,
        margin: {
            top: '0.3in',
            right: '0.3in',
            bottom: '0.3in',
            left: '0.3in'
        }
    });

    await browser.close();
    return { pdfBuffer, exceedsOnePage: height > MAX_HEIGHT };
}

// Add new function to manage bullet points
async function adjustBulletPoints($, sections, currentBulletCount) {
    // Reduce bullets in all sections equally
    sections.forEach(section => {
        const bulletList = $(section).find('ul');
        const bullets = bulletList.find('li');
        if (bullets.length > currentBulletCount) {
            // Remove the last bullet
            bullets.last().remove();
        }
    });
    return currentBulletCount - 1;
}

// Main Resume Update Function
async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const sectionWordCounts = getSectionWordCounts($);
    const bulletTracker = new SectionBulletTracker();
    const verbTracker = new ActionVerbTracker();
    const bulletCache = new BulletCache();
    
    // Extract original bullets before any modifications
    const originalBullets = extractOriginalBullets($);
    
    const INITIAL_BULLET_COUNT = 6;
    const MIN_BULLETS = 3;
    
    const keywordString = fullTailoring ? 
        keywords.join(', ') : 
        keywords.slice(0, Math.min(5, keywords.length)).join(', ');

    // Generate general bullet points for each section type upfront
    console.log("Generating initial bullet points for all section types...");
    const allBullets = await bulletCache.generateAllBullets($, keywords, 'resume section', 15);
    
    // If we failed to generate enough bullets for any section, we'll try a few more times
    for (const sectionType of ['job', 'project', 'education']) {
        if (!allBullets[sectionType] || allBullets[sectionType].length < MIN_BULLETS) {
            console.log(`Not enough initial bullets for ${sectionType}, generating more...`);
            try {
                const moreBullets = await generateBullets(
                    'generate', null, keywords, `for ${sectionType} experience`, 15
                );
                if (!allBullets[sectionType]) {
                    allBullets[sectionType] = [];
                }
                allBullets[sectionType] = [...allBullets[sectionType], ...moreBullets];
                
                // Add to section pool
                moreBullets.forEach(bp => bulletCache.addBulletToSection(bp, sectionType));
            } catch (error) {
                console.error(`Error generating additional bullets for ${sectionType}:`, error);
            }
        }
    }

    const sections = [
        { selector: $('.job-details'), type: 'job', context: 'for a job experience', bullets: originalBullets.job },
        { selector: $('.project-details'), type: 'project', context: 'for a project', bullets: originalBullets.project },
        { selector: $('.education-details'), type: 'education', context: 'for education', bullets: originalBullets.education }
    ];

    // Extract position IDs
    const positionIds = generatePositionIds($);

    // Update each section with its specific context
    for (const section of sections) {
        try {
            console.log(`Updating section type: ${section.type} with ${section.selector.length} positions`);
            
            await updateResumeSection(
                $, section.selector, keywordString, section.context,
                fullTailoring, sectionWordCounts[section.type],
                bulletTracker, section.type, section.bullets,
                INITIAL_BULLET_COUNT, verbTracker, bulletCache, positionIds
            );
        } catch (error) {
            console.error(`Error updating ${section.type} section:`, error);
        }
    }

    // Check and adjust page length with smarter space management
    let currentBulletCount = INITIAL_BULLET_COUNT;
    let attempts = 0;

    while (attempts < 3 && currentBulletCount >= MIN_BULLETS) {
        try {
            const { exceedsOnePage } = await convertHtmlToPdf($.html());
            if (!exceedsOnePage) break;

            // Reduce bullets proportionally based on section importance
            currentBulletCount--;
            for (const section of sections) {
                const adjustedCount = Math.max(
                    MIN_BULLETS,
                    Math.floor(currentBulletCount * (section.type === 'job' ? 1 : 0.8))
                );
                await adjustSectionBullets(
                    $, section.selector, adjustedCount,
                    section.type, bulletTracker, keywordString,
                    section.context, bulletCache, positionIds
                );
            }
        } catch (error) {
            console.error('Error checking page length:', error);
        }
        attempts++;
    }

    // Final check: verify each position has at least some bullet points
    // This is a safety net in case earlier steps failed
    console.log("Performing final check for bullet points...");
    for (const section of sections) {
        section.selector.each((index, element) => {
            const $section = $(element);
            const bulletList = $section.find('ul');
            const bullets = bulletList.find('li');
            
            if (bullets.length === 0) {
                console.log(`WARNING: Position ${index} in ${section.type} section has no bullets. Attempting emergency fix...`);
                
                // Get position name for logging
                let positionName = "unknown";
                if (section.type === 'job') {
                    positionName = $section.find('.company-name').text().trim() || 
                                   $section.find('.position-title').text().trim();
                } else if (section.type === 'project') {
                    positionName = $section.find('.project-title').text().trim();
                } else {
                    positionName = $section.find('.school-name').text().trim();
                }
                
                console.log(`Fixing missing bullets for: ${positionName}`);
                
                // Get bullets from the section pool as emergency fallback
                const emergencyBullets = bulletCache.getBulletsForSection(section.type, MIN_BULLETS);
                if (emergencyBullets.length > 0) {
                    // Create bullet list if needed
                    if (bulletList.length === 0) {
                        $section.append('<ul></ul>');
                    }
                    
                    // Add bullets
                    emergencyBullets.forEach(bullet => {
                        $section.find('ul').append(`<li>${bullet}</li>`);
                    });
                    
                    console.log(`Added ${emergencyBullets.length} emergency bullets to ${positionName}`);
                } else {
                    console.log(`No emergency bullets available for ${positionName}`);
                }
            }
        });
    }

    return $.html();
}

async function updateResumeSection($, sections, keywords, context, fullTailoring, wordLimit, bulletTracker, sectionType, originalBullets, targetBulletCount, verbTracker, bulletCache, positionIds) {
    for (let i = 0; i < sections.length; i++) {
        const section = sections.eq(i);
        let bulletList = section.find('ul');
        const positionId = positionIds[sectionType][i] || `${sectionType}-${i}`;

        if (bulletList.length === 0) {
            section.append('<ul></ul>');
            bulletList = section.find('ul');
        }

        let bulletPoints = bulletCache.getBulletsForPosition(positionId, targetBulletCount);
        
        if (fullTailoring && bulletList.find('li').length > 0) {
            const existingBullets = bulletList.find('li')
                .map((_, el) => $(el).text())
                .get();
                
            bulletPoints = await generateBullets(
                'tailor', existingBullets,
                keywords, context, wordLimit
            );
            
            // Add tailored bullets to position-specific cache
            bulletPoints.forEach(bp => bulletCache.addBulletToPosition(bp, positionId));
        }

        // Filter and shuffle bullets
        bulletPoints = bulletPoints
            .filter(bp => !bulletTracker.isUsed(bp) || 
                         bulletTracker.canUseBulletInSection(bp, positionId))
            .slice(0, targetBulletCount);

        // Shuffle bullets with verb checking
        bulletPoints = shuffleBulletsWithVerbCheck(bulletPoints, sectionType, verbTracker);

        // Update bullet list
        bulletList.empty();
        bulletPoints.forEach(point => {
            bulletTracker.addBullet(point, positionId);
            bulletList.append(`<li>${point}</li>`);
        });
    }
}

async function customizeResume(req, res) {
    try {
        const { htmlContent, keywords, fullTailoring } = req.body;

        if (!htmlContent || !Array.isArray(keywords)) {
            return res.status(400).send('Invalid input: HTML content and keywords array are required');
        }

        console.log('Received keywords:', keywords);
        console.log('Full tailoring enabled:', fullTailoring);

        const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        const { pdfBuffer, exceedsOnePage } = await convertHtmlToPdf(updatedHtmlContent);

        if (exceedsOnePage) {
            console.warn('Warning: Resume still exceeds one page after adjustments');
        }

        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=customized_resume.pdf');
        res.send(Buffer.from(pdfBuffer));

    } catch (error) {
        console.error('Error processing resume:', error);
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

module.exports = { customizeResume };
