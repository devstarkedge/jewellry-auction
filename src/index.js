import dotenv from "dotenv";
import cron from "node-cron";
import http from "http";

dotenv.config();

/* ============================================================
   ENV
============================================================ */

const {
    SHOPIFY_STORE_DOMAIN,
    SHOPIFY_ADMIN_ACCESS_TOKEN,
    SHOPIFY_API_VERSION,
    SHOPIFY_PRODUCT_ID,
    SHOPIFY_VARIANT_ID,
    MIN_PRICE,
    DROP_MIN,
    DROP_MAX,
    DROP_EVERY_HOURS
} = process.env;


/* ============================================================
   VALIDATION
============================================================ */

if (!SHOPIFY_STORE_DOMAIN) {
    throw new Error("SHOPIFY_STORE_DOMAIN is missing");
}

if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
    throw new Error("SHOPIFY_ADMIN_ACCESS_TOKEN is missing");
}

if (!SHOPIFY_API_VERSION) {
    throw new Error("SHOPIFY_API_VERSION is missing");
}

if (!SHOPIFY_PRODUCT_ID) {
    throw new Error("SHOPIFY_PRODUCT_ID is missing");
}

if (!SHOPIFY_VARIANT_ID) {
    throw new Error("SHOPIFY_VARIANT_ID is missing");
}


/* ============================================================
   CONFIG
============================================================ */

const dropMin = Number(DROP_MIN);
const dropMax = Number(DROP_MAX);

if (!Number.isFinite(dropMin)) {
    throw new Error("DROP_MIN must be a valid number");
}

if (!Number.isFinite(dropMax)) {
    throw new Error("DROP_MAX must be a valid number");
}

if (dropMin <= 0 || dropMax <= 0) {
    throw new Error("DROP_MIN and DROP_MAX must be greater than 0");
}

if (dropMin > dropMax) {
    throw new Error("DROP_MIN cannot be greater than DROP_MAX");
}


/* ============================================================
   SHOPIFY GRAPHQL URL
============================================================ */

const graphqlUrl =
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;


/* ============================================================
   LOCAL API STATE
============================================================ */

let latestPrice = null;
let openingPrice = null;
let minPriceState = null;
let dropEveryHoursState = null;
let latestUpdatedAt = null;


/* ============================================================
   SHOPIFY GRAPHQL HELPER
============================================================ */

async function shopifyGraphQL(query, variables = {}) {

    const response = await fetch(graphqlUrl, {
        method: "POST",

        headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN
        },

        body: JSON.stringify({
            query,
            variables
        })
    });


    let json;

    try {
        json = await response.json();
    } catch (error) {

        throw new Error(
            `Shopify returned invalid JSON. HTTP ${response.status}`
        );

    }


    if (!response.ok) {

        throw new Error(
            `Shopify API HTTP ${response.status}: ${JSON.stringify(json)}`
        );

    }


    if (json.errors) {

        throw new Error(
            `Shopify GraphQL error: ${JSON.stringify(json.errors)}`
        );

    }


    return json.data;
}


/* ============================================================
   PRODUCT METAFIELD HELPER
============================================================ */

function getProductMetafieldNumber(variant, fieldName, envFallback) {
    /*
     * Fetch strictly from Product Metafield
     */
    const productMeta = variant.product?.[fieldName]?.value;

    const rawVal = productMeta ?? envFallback;

    if (rawVal === undefined || rawVal === null || rawVal === "") {
        return null;
    }

    const num = Number(rawVal);
    return Number.isFinite(num) ? num : null;
}


/* ============================================================
   GET VARIANT
============================================================ */

async function getVariant() {

    const query = `
        query($id: ID!) {

            productVariant(id: $id) {

                id

                title

                price

                compareAtPrice

                inventoryQuantity

                inventoryPolicy

                inventoryItem {
                    id
                }

                product {
                    id
                    title
                    reservePriceMetafield: metafield(namespace: "custom", key: "reserve_price") {
                        value
                    }
                    dropEveryHoursMetafield: metafield(namespace: "custom", key: "drop_every_hours") {
                        value
                    }
                }

            }

        }
    `;


    const data = await shopifyGraphQL(
        query,
        {
            id: SHOPIFY_VARIANT_ID
        }
    );


    if (!data?.productVariant) {

        throw new Error(
            "Shopify variant was not found"
        );

    }


    return data.productVariant;
}


/* ============================================================
   UPDATE VARIANT PRICE
============================================================ */

async function updateVariant(
    productId,
    variantId,
    newPrice,
    permanentOpeningPrice
) {

    const mutation = `
        mutation(
            $productId: ID!,
            $variants: [ProductVariantsBulkInput!]!
        ) {

            productVariantsBulkUpdate(
                productId: $productId,
                variants: $variants
            ) {

                productVariants {

                    id

                    price

                    compareAtPrice

                }

                userErrors {

                    field

                    message

                }

            }

        }
    `;


    const data = await shopifyGraphQL(
        mutation,
        {
            productId,

            variants: [
                {
                    id: variantId,

                    /*
                     * Whole pounds only
                     */
                    price: Number(newPrice).toFixed(2),

                    /*
                     * Opening price remains fixed
                     */
                    compareAtPrice:
                        Number(permanentOpeningPrice).toFixed(2)
                }
            ]
        }
    );


    const userErrors =
        data?.productVariantsBulkUpdate?.userErrors || [];


    if (userErrors.length > 0) {

        throw new Error(
            `Variant update failed: ${JSON.stringify(userErrors)}`
        );

    }


    const updatedVariant =
        data?.productVariantsBulkUpdate?.productVariants?.[0];


    if (!updatedVariant) {

        throw new Error(
            "Shopify did not return the updated variant"
        );

    }


    return updatedVariant;
}


/* ============================================================
   RANDOM DROP
============================================================ */

function randomDrop(min, max) {

    return Math.random() * (max - min) + min;

}


/* ============================================================
   ROUND PRICE
============================================================ */

function roundPrice(price) {

    return Math.round(
        Number(price)
    );

}


/* ============================================================
   DYNAMIC TIMER SCHEDULER (SECONDS)
============================================================ */

let activeIntervalTimer = null;
let activeIntervalSeconds = null;

function updateIntervalSchedule(secondsVal) {

    /*
     * If TEST_MODE=true in .env, run every 5 seconds for rapid testing
     */
    if (process.env.TEST_MODE === "true") {

        const testSec = 5;

        if (activeIntervalSeconds === testSec && activeIntervalTimer) {
            return;
        }

        if (activeIntervalTimer) {
            clearInterval(activeIntervalTimer);
        }

        console.log("Timer scheduled: Every 5 seconds (TEST_MODE=true)");

        activeIntervalTimer = setInterval(dropPrice, testSec * 1000);
        activeIntervalSeconds = testSec;
        return;

    }


    /*
     * Dynamic interval in SECONDS based on product metafield custom.drop_every_hours
     */
    const seconds = Math.max(1, Math.floor(Number(secondsVal) || 5));

    if (activeIntervalSeconds === seconds && activeIntervalTimer) {
        return;
    }

    if (activeIntervalTimer) {
        clearInterval(activeIntervalTimer);
    }

    console.log(
        `Timer scheduled: Every ${seconds} second(s) based on product metafield custom.drop_every_hours`
    );

    activeIntervalTimer = setInterval(dropPrice, seconds * 1000);
    activeIntervalSeconds = seconds;

}


/* ============================================================
   PRICE UPDATE JOB
============================================================ */

async function dropPrice() {

    try {

        const variant = await getVariant();


        /*
         * ----------------------------------------------------
         * DYNAMIC PRODUCT METAFIELDS RESOLUTION
         *
         * MIN_PRICE        -> product.custom.reserve_price
         * DROP_EVERY_HOURS -> product.custom.drop_every_hours
         * ----------------------------------------------------
         */

        const resolvedMinPrice = getProductMetafieldNumber(
            variant,
            "reservePriceMetafield",
            process.env.MIN_PRICE
        );

        const minPrice = resolvedMinPrice !== null ? resolvedMinPrice : 0;


        const resolvedDropEveryHours = getProductMetafieldNumber(
            variant,
            "dropEveryHoursMetafield",
            process.env.DROP_EVERY_HOURS
        );

        const dropEveryHours = resolvedDropEveryHours !== null ? resolvedDropEveryHours : 6;


        minPriceState = minPrice;
        dropEveryHoursState = dropEveryHours;
        updateIntervalSchedule(dropEveryHours);


        /*
         * Current Shopify price
         */
        const currentPrice =
            Number(variant.price);


        if (!Number.isFinite(currentPrice)) {

            throw new Error(
                `Invalid Shopify price: ${variant.price}`
            );

        }


        /*
         * ----------------------------------------------------
         * OPENING PRICE
         *
         * compareAtPrice stores the permanent opening price.
         * Once initialized, it never changes.
         * ----------------------------------------------------
         */

        let permanentOpeningPrice =
            Number(variant.compareAtPrice);


        if (
            !Number.isFinite(permanentOpeningPrice) ||
            permanentOpeningPrice <= 0
        ) {

            permanentOpeningPrice =
                roundPrice(currentPrice);


            console.log(
                `Opening price initialized: £${permanentOpeningPrice}`
            );

        }


        /*
         * ----------------------------------------------------
         * KEEP OPENING PRICE IN MEMORY
         * ----------------------------------------------------
         */

        openingPrice =
            permanentOpeningPrice;


        /*
         * ----------------------------------------------------
         * CURRENT BASE PRICE
         * ----------------------------------------------------
         */

        let basePrice =
            roundPrice(currentPrice);


        /*
         * ----------------------------------------------------
         * MINIMUM PRICE REACHED
         *
         * Example:
         *
         * Opening = £5,000
         * Minimum = £950 (from custom.reserve_price)
         *
         * When current reaches minPrice,
         * next cycle starts again from £5,000.
         * ----------------------------------------------------
         */

        if (basePrice <= minPrice) {

            basePrice =
                permanentOpeningPrice;


            console.log(
                `Minimum price (£${minPrice}) reached. Restarting from opening price: £${permanentOpeningPrice}`
            );

        }


        /*
         * ----------------------------------------------------
         * RANDOM DROP
         * ----------------------------------------------------
         */

        const drop =
            randomDrop(
                dropMin,
                dropMax
            );


        /*
         * ----------------------------------------------------
         * NEW PRICE
         * ----------------------------------------------------
         */

        let nextPrice =
            basePrice - drop;


        /*
         * Round to whole pounds
         */
        nextPrice =
            roundPrice(nextPrice);


        /*
         * Never go below minimum
         */
        nextPrice =
            Math.max(
                minPrice,
                nextPrice
            );


        /*
         * ----------------------------------------------------
         * UPDATE SHOPIFY
         * ----------------------------------------------------
         */

        const updatedVariant =
            await updateVariant(
                SHOPIFY_PRODUCT_ID,
                SHOPIFY_VARIANT_ID,
                nextPrice,
                permanentOpeningPrice
            );


        /*
         * ----------------------------------------------------
         * UPDATE LOCAL API STATE
         * ----------------------------------------------------
         */

        latestPrice =
            roundPrice(
                Number(updatedVariant.price)
            );


        openingPrice =
            roundPrice(
                permanentOpeningPrice
            );


        latestUpdatedAt =
            new Date().toISOString();


        /*
         * ----------------------------------------------------
         * LOG
         * ----------------------------------------------------
         */

        console.log(
            `Price updated: £${basePrice} → £${latestPrice} | Opening: £${openingPrice} | Min Price (custom.reserve_price): £${minPrice} | Drop Every: ${dropEveryHours}s`
        );


    } catch (error) {

        console.error(
            "Price update failed:",
            error.message
        );

    }

}


/* ============================================================
   INITIALIZE CURRENT PRICE
============================================================ */

async function initializePrice() {

    try {

        const variant =
            await getVariant();


        const resolvedMinPrice = getProductMetafieldNumber(
            variant,
            "reservePriceMetafield",
            process.env.MIN_PRICE
        );

        const minPrice = resolvedMinPrice !== null ? resolvedMinPrice : 0;


        const resolvedDropEveryHours = getProductMetafieldNumber(
            variant,
            "dropEveryHoursMetafield",
            process.env.DROP_EVERY_HOURS
        );

        const dropEveryHours = resolvedDropEveryHours !== null ? resolvedDropEveryHours : 6;


        minPriceState = minPrice;
        dropEveryHoursState = dropEveryHours;


        latestPrice =
            roundPrice(
                Number(variant.price)
            );


        /*
         * Existing compare-at price becomes
         * permanent opening price.
         */
        if (
            variant.compareAtPrice &&
            Number(variant.compareAtPrice) > 0
        ) {

            openingPrice =
                roundPrice(
                    Number(variant.compareAtPrice)
                );

        } else {

            /*
             * First ever run:
             * current Shopify price becomes opening price.
             */

            openingPrice =
                latestPrice;


            /*
             * Save opening price immediately
             */
            await updateVariant(
                SHOPIFY_PRODUCT_ID,
                SHOPIFY_VARIANT_ID,
                latestPrice,
                openingPrice
            );

        }


        latestUpdatedAt =
            new Date().toISOString();


        console.log(
            `Opening price: £${openingPrice}`
        );

        console.log(
            `Current price: £${latestPrice}`
        );

        console.log(
            `Min price (custom.reserve_price): £${minPriceState}`
        );

        console.log(
            `Drop interval (custom.drop_every_hours): ${dropEveryHoursState}s`
        );


    } catch (error) {

        console.error(
            "Price initialization failed:",
            error.message
        );

    }

}


/* ============================================================
   API RESPONSE
============================================================ */

function sendJson(
    res,
    statusCode,
    data
) {

    res.writeHead(
        statusCode,
        {
            "Content-Type": "application/json",

            /*
             * Prevent browser/CDN caching
             */
            "Cache-Control":
                "no-store, no-cache, must-revalidate, proxy-revalidate",

            "Pragma": "no-cache",

            "Expires": "0",

            /*
             * CORS
             */
            "Access-Control-Allow-Origin": "*",

            "Access-Control-Allow-Methods":
                "GET, OPTIONS",

            "Access-Control-Allow-Headers":
                "*"
        }
    );


    res.end(
        JSON.stringify(data)
    );

}


/* ============================================================
   HTTP SERVER & HANDLER
============================================================ */

async function handleRequest(req, res) {

    if (latestPrice === null) {
        await initializePrice();
    }

    /*
     * ------------------------------------------------
     * CORS
     * ------------------------------------------------
     */

    res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
    );

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "*"
    );


    /*
     * ------------------------------------------------
     * OPTIONS / PREFLIGHT
     * ------------------------------------------------
     */

    if (req.method === "OPTIONS") {

        res.writeHead(
            204,
            {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "*"
            }
        );

        res.end();

        return;

    }



    /*
     * ------------------------------------------------
     * PRICE API
     * ------------------------------------------------
     */

    if (
        req.url.startsWith("/api/price") &&
        req.method === "GET"
    ) {

        sendJson(
            res,
            200,
            {
                success: true,

                /*
                 * Current dropped price
                 */
                price:
                    latestPrice,

                /*
                 * Permanent opening price
                 */
                openingPrice:
                    openingPrice,

                /*
                 * Reserve / Min price from metafield custom.reserve_price
                 */
                minPrice:
                    minPriceState,

                /*
                 * Drop interval from metafield custom.drop_every_hours (in seconds)
                 */
                dropEverySeconds:
                    dropEveryHoursState,

                currency:
                    "GBP",

                updatedAt:
                    latestUpdatedAt
            }
        );

        return;

    }


    /*
     * ------------------------------------------------
     * HEALTH CHECK
     * ------------------------------------------------
     */

    if (
        req.url === "/" || req.url === "" &&
        req.method === "GET"
    ) {

        sendJson(
            res,
            200,
            {
                success: true,

                message:
                    "Auction API is running",

                price:
                    latestPrice,

                openingPrice:
                    openingPrice,

                minPrice:
                    minPriceState,

                dropEverySeconds:
                    dropEveryHoursState,

                currency:
                    "GBP",

                updatedAt:
                    latestUpdatedAt
            }
        );

        return;

    }




    sendJson(
        res,
        404,
        {
            success: false,

            message:
                "Endpoint not found"
        }
    );

}

export default handleRequest;

const server = http.createServer(handleRequest);


/* ============================================================
   START SERVER (LOCAL DEVELOPMENT)
============================================================ */

const PORT =
    process.env.PORT || 3000;

if (!process.env.VERCEL) {
    server.listen(
        PORT,
        async () => {

            console.log(
                `Auction API running on http://localhost:${PORT}`
            );


            /*
             * Load current Shopify price
             * and schedule timer dynamically (seconds).
             */
            await initializePrice();


            /*
             * Schedule timer job based on custom.drop_every_hours metafield (seconds)
             */
            updateIntervalSchedule(dropEveryHoursState);

        }
    );
}
