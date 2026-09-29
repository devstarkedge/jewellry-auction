import { unauthenticated } from "../shopify.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const handle = url.searchParams.get("handle");
  const shop = url.searchParams.get("shop");

  let cleanShop = (shop || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  if (cleanShop && !cleanShop.includes(".")) {
    cleanShop += ".myshopify.com";
  }

  if (!handle || !cleanShop) {
    return Response.json(
      { success: false, error: "Missing handle or shop parameter" },
      { headers: corsHeaders, status: 400 }
    );
  }

  try {
    const { admin } = await unauthenticated.admin(cleanShop);

    const response = await admin.graphql(
      `#graphql
        query getProductAuction($handle: String!) {
          productByHandle(handle: $handle) {
            id
            title
            variants(first: 1) {
              edges {
                node {
                  id
                  price
                  compareAtPrice
                }
              }
            }
            auctionSettingsNew: metafield(namespace: "auction", key: "settings") {
              value
            }
            auctionSettingsOld: metafield(namespace: "custom", key: "auction_settings") {
              value
            }
            customReservePrice: metafield(namespace: "custom", key: "reserve_price") {
              value
            }
            customPriceDropAmount: metafield(namespace: "custom", key: "price_drop_amount") {
              value
            }
            customDropEveryHours: metafield(namespace: "custom", key: "drop_every_hours") {
              value
            }
          }
        }
      `,
      { variables: { handle } }
    );

    const json = await response.json();
    const product = json?.data?.productByHandle;

    if (!product) {
      return Response.json(
        { success: false, error: "Product not found" },
        { headers: corsHeaders, status: 404 }
      );
    }

    const variantNode = product.variants?.edges?.[0]?.node;
    const shopifyPrice = parseFloat(variantNode?.price || "0");
    const shopifyCompareAt = parseFloat(variantNode?.compareAtPrice || "0");

    const defaultOpeningPrice = shopifyCompareAt > 0 ? shopifyCompareAt : shopifyPrice;
    const reservePriceFromCustom = product.customReservePrice?.value ? parseFloat(product.customReservePrice.value) : null;
    const priceDropFromCustom = product.customPriceDropAmount?.value ? parseFloat(product.customPriceDropAmount.value) : null;
    const dropEveryHoursFromCustom = product.customDropEveryHours?.value ? parseFloat(product.customDropEveryHours.value) : null;

    let auctionData = {
      openingAuctionPrice: defaultOpeningPrice,
      reservePrice: reservePriceFromCustom ?? 0,
      priceDropIntervalValue: dropEveryHoursFromCustom ?? 5,
      priceDropIntervalUnit: dropEveryHoursFromCustom !== null ? "Hours" : "Minutes",
      priceDrop: priceDropFromCustom ?? 0,
      isAuctionRunning: false,
      auctionStartTime: null,
    };

    const rawSettings = product.auctionSettingsNew?.value || product.auctionSettingsOld?.value;
    if (rawSettings) {
      try {
        const parsed = JSON.parse(rawSettings);
        auctionData = {
          openingAuctionPrice: parsed.openingAuctionPrice ?? defaultOpeningPrice,
          reservePrice: reservePriceFromCustom ?? (parsed.reservePrice ?? 0),
          priceDropIntervalValue: parsed.priceDropIntervalValue ?? (dropEveryHoursFromCustom ?? 5),
          priceDropIntervalUnit: parsed.priceDropIntervalUnit || (dropEveryHoursFromCustom !== null ? "Hours" : "Minutes"),
          priceDrop: priceDropFromCustom ?? (parsed.priceDrop ?? 0),
          isAuctionRunning: Boolean(parsed.isAuctionRunning),
          auctionStartTime: parsed.auctionStartTime ?? null,
        };
      } catch (e) { }
    }

    let currentPrice = shopifyPrice;
    let nextDropInSeconds = 0;
    let hasReachedReserve = false;

    // Only calculate price drop if auction is RUNNING (isAuctionRunning: true)
    if (auctionData.isAuctionRunning && auctionData.auctionStartTime) {
      const now = Date.now();
      const elapsedMs = Math.max(0, now - auctionData.auctionStartTime);
      let intervalMs = 300000;

      const val = auctionData.priceDropIntervalValue || 1;
      const unit = auctionData.priceDropIntervalUnit || "Minutes";

      if (unit === "Seconds") intervalMs = val * 1000;
      else if (unit === "Minutes") intervalMs = val * 60 * 1000;
      else if (unit === "Hours") intervalMs = val * 3600 * 1000;
      else if (unit === "Days") intervalMs = val * 86400 * 1000;

      const intervalsPassed = Math.floor(elapsedMs / intervalMs);
      const totalDrop = intervalsPassed * (auctionData.priceDrop || 0);
      const rawCalculatedPrice = auctionData.openingAuctionPrice - totalDrop;
      const reservePrice = auctionData.reservePrice || 0;

      currentPrice = Math.max(reservePrice, rawCalculatedPrice);
      hasReachedReserve = rawCalculatedPrice <= reservePrice;

      const msToNextDrop = intervalMs - (elapsedMs % intervalMs);
      nextDropInSeconds = hasReachedReserve ? 0 : Math.ceil(msToNextDrop / 1000);
    }

    return Response.json(
      {
        success: true,
        price: currentPrice,
        currentPrice,
        openingPrice: auctionData.openingAuctionPrice,
        shopifyPrice,
        shopifyCompareAt,
        reservePrice: auctionData.reservePrice,
        priceDrop: auctionData.priceDrop,
        priceDropIntervalValue: auctionData.priceDropIntervalValue,
        priceDropIntervalUnit: auctionData.priceDropIntervalUnit,
        auctionStartTime: auctionData.auctionStartTime,
        isAuctionRunning: auctionData.isAuctionRunning,
        nextDropInSeconds,
        hasReachedReserve,
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("Error fetching live price:", error);
    return Response.json(
      { success: false, error: error.message },
      { headers: corsHeaders, status: 500 }
    );
  }
};
