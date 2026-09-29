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

  if (!handle || !shop) {
    // Fallback: If no handle/shop passed, return success with default structure for testing
    return Response.json(
      { success: true, price: 0, currentPrice: 0, openingPrice: 0 },
      { headers: corsHeaders }
    );
  }

  try {
    const { admin } = await unauthenticated.admin(shop);

    const response = await admin.graphql(
      `#graphql
        query getProductAuction($handle: String!) {
          productByHandle(handle: $handle) {
            id
            title
            variants(first: 1) {
              edges {
                node {
                  price
                }
              }
            }
            auctionSettings: metafield(namespace: "custom", key: "auction_settings") {
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

    const defaultOpeningPrice = parseFloat(product.variants?.edges?.[0]?.node?.price || "0");
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

    if (product.auctionSettings?.value) {
      try {
        const parsed = JSON.parse(product.auctionSettings.value);
        auctionData = {
          openingAuctionPrice: parsed.openingAuctionPrice ?? defaultOpeningPrice,
          reservePrice: reservePriceFromCustom ?? (parsed.reservePrice ?? 0),
          priceDropIntervalValue: parsed.priceDropIntervalValue ?? (dropEveryHoursFromCustom ?? 5),
          priceDropIntervalUnit: parsed.priceDropIntervalUnit || (dropEveryHoursFromCustom !== null ? "Hours" : "Minutes"),
          priceDrop: priceDropFromCustom ?? (parsed.priceDrop ?? 0),
          isAuctionRunning: parsed.isAuctionRunning ?? false,
          auctionStartTime: parsed.auctionStartTime ?? null,
        };
      } catch (e) {}
    }

    // Calculate live auction state
    let currentPrice = auctionData.openingAuctionPrice;
    let nextDropInSeconds = 0;
    let hasReachedReserve = false;

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
        reservePrice: auctionData.reservePrice,
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
