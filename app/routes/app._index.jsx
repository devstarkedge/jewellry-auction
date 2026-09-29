import { useEffect, useState, useRef } from "react";
import {
  useLoaderData,
  useFetcher,
  useSearchParams,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// Helper function to calculate real-time auction state
const calculateAuctionState = (auction) => {
  if (!auction?.isAuctionRunning || !auction?.auctionStartTime) {
    return {
      currentPrice: auction?.openingAuctionPrice || 0,
      nextDropInSeconds: 0,
      hasReachedReserve: false,
    };
  }

  const now = Date.now();
  const elapsedMs = Math.max(0, now - auction.auctionStartTime);
  let intervalMs = 300000; // default 5 minutes

  const val = auction.priceDropIntervalValue || 1;
  const unit = auction.priceDropIntervalUnit || "Minutes";

  if (unit === "Seconds") intervalMs = val * 1000;
  else if (unit === "Minutes") intervalMs = val * 60 * 1000;
  else if (unit === "Hours") intervalMs = val * 3600 * 1000;
  else if (unit === "Days") intervalMs = val * 86400 * 1000;

  const intervalsPassed = Math.floor(elapsedMs / intervalMs);
  const totalDrop = intervalsPassed * (auction.priceDrop || 0);
  const rawCalculatedPrice = auction.openingAuctionPrice - totalDrop;
  const reservePrice = auction.reservePrice || 0;

  const currentPrice = Math.max(reservePrice, rawCalculatedPrice);
  const hasReachedReserve = rawCalculatedPrice <= reservePrice;

  // Calculate seconds remaining until next drop
  const msToNextDrop = intervalMs - (elapsedMs % intervalMs);
  const nextDropInSeconds = hasReachedReserve ? 0 : Math.ceil(msToNextDrop / 1000);

  return {
    currentPrice,
    nextDropInSeconds,
    hasReachedReserve,
  };
};

// Format countdown seconds into readable format (e.g. 45s, 3m 12s, 2h 5m)
const formatCountdown = (totalSeconds) => {
  if (totalSeconds <= 0) return "0s";
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${mins}m`;
};

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  const search = url.searchParams.get("search") || "";

  // Cursor-based pagination logic (25 products per page)
  let paginationArgs = `first: 25`;
  if (after) {
    paginationArgs = `first: 25, after: "${after}"`;
  } else if (before) {
    paginationArgs = `last: 25, before: "${before}"`;
  }

  const queryArg = search ? `, query: "title:*${search.replace(/"/g, '\\*')}*"` : "";

  const response = await admin.graphql(
    `#graphql
      query getProducts {
        products(${paginationArgs}${queryArg}) {
          edges {
            cursor
            node {
              id
              title
              status
              featuredImage {
                url
                altText
              }
              media(first: 5) {
                edges {
                  node {
                    mediaContentType
                    preview {
                      image {
                        url
                        altText
                      }
                    }
                  }
                }
              }
              images(first: 1) {
                edges {
                  node {
                    url
                    altText
                  }
                }
              }
              variants(first: 1) {
                edges {
                  node {
                    id
                    price
                    compareAtPrice
                  }
                }
              }
              auctionSettings: metafield(namespace: "auction", key: "settings") {
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
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }`
  );

  const responseJson = await response.json();
  const productsEdges = responseJson.data?.products?.edges || [];
  const pageInfo = responseJson.data?.products?.pageInfo || {
    hasNextPage: false,
    hasPreviousPage: false,
    startCursor: null,
    endCursor: null,
  };

  const products = productsEdges.map((edge) => {
    const node = edge.node;
    const variantNode = node.variants?.edges?.[0]?.node;
    const variantId = variantNode?.id || "";
    const price = variantNode?.price || "0.00";
    const compareAtPrice = variantNode?.compareAtPrice || "";

    const defaultOpeningPrice = parseFloat(compareAtPrice) > 0 ? parseFloat(compareAtPrice) : parseFloat(price) || 0;

    const reservePriceFromCustom = node.customReservePrice?.value ? parseFloat(node.customReservePrice.value) : null;
    const priceDropFromCustom = node.customPriceDropAmount?.value ? parseFloat(node.customPriceDropAmount.value) : null;
    const dropEveryHoursFromCustom = node.customDropEveryHours?.value ? parseFloat(node.customDropEveryHours.value) : null;

    let auctionData = {
      openingAuctionPrice: defaultOpeningPrice,
      reservePrice: reservePriceFromCustom ?? 0,
      priceDropIntervalValue: dropEveryHoursFromCustom ?? 5,
      priceDropIntervalUnit: dropEveryHoursFromCustom !== null ? "Hours" : "Minutes",
      priceDrop: priceDropFromCustom ?? 0,
      isAuctionRunning: false,
      auctionStartTime: null,
      isConfigured: false,
    };

    if (node.auctionSettings?.value) {
      try {
        const parsed = JSON.parse(node.auctionSettings.value);
        auctionData = {
          openingAuctionPrice: parsed.openingAuctionPrice ?? defaultOpeningPrice,
          reservePrice: reservePriceFromCustom ?? (parsed.reservePrice ?? 0),
          priceDropIntervalValue: parsed.priceDropIntervalValue ?? (dropEveryHoursFromCustom ?? 5),
          priceDropIntervalUnit: parsed.priceDropIntervalUnit || (dropEveryHoursFromCustom !== null ? "Hours" : "Minutes"),
          priceDrop: priceDropFromCustom ?? (parsed.priceDrop ?? 0),
          isAuctionRunning: parsed.isAuctionRunning ?? false,
          auctionStartTime: parsed.auctionStartTime ?? null,
          isConfigured: true,
        };
      } catch (e) {
        // Fallback to defaults if JSON parsing fails
      }
    } else if (reservePriceFromCustom !== null || priceDropFromCustom !== null || dropEveryHoursFromCustom !== null) {
      auctionData.isConfigured = true;
    }

    // Extract first media (Video preview image or Image)
    let imageUrl = "";
    let isVideo = false;

    const firstMediaNode = node.media?.edges?.[0]?.node;
    if (firstMediaNode) {
      const type = firstMediaNode.mediaContentType;
      if (type === "VIDEO" || type === "EXTERNAL_VIDEO") {
        isVideo = true;
      }
      imageUrl = firstMediaNode.preview?.image?.url || "";
    }

    if (!imageUrl) {
      imageUrl = node.featuredImage?.url || node.images?.edges?.[0]?.node?.url || "";
    }

    return {
      id: node.id,
      numericId: node.id.replace("gid://shopify/Product/", ""),
      variantId: variantId,
      title: node.title,
      status: node.status,
      imageUrl: imageUrl,
      isVideo: isVideo,
      price: price,
      compareAtPrice: compareAtPrice,
      cursor: edge.cursor,
      auction: auctionData,
    };
  });

  return {
    products,
    pageInfo,
    search,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "status_change" || intent === "draft") {
    const productId = formData.get("productId");
    const targetStatus = formData.get("status") || "DRAFT"; // "ACTIVE" or "DRAFT"

    const response = await admin.graphql(
      `#graphql
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product {
              id
              title
              status
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          input: {
            id: productId,
            status: targetStatus,
          },
        },
      }
    );

    const responseJson = await response.json();
    const userErrors = responseJson.data?.productUpdate?.userErrors || [];
    const updatedProduct = responseJson.data?.productUpdate?.product;

    if (userErrors.length > 0) {
      return {
        success: false,
        intent: "status_change",
        error: userErrors[0].message,
      };
    }

    return {
      success: true,
      intent: "status_change",
      productId,
      status: updatedProduct?.status || targetStatus,
    };
  }

  if (intent === "toggle_auction") {
    const productId = formData.get("productId");
    const variantId = formData.get("variantId");
    const targetState = formData.get("isAuctionRunning") === "true";
    const startTime = targetState ? Date.now() : null;

    // 1. Get current auction settings from Shopify Metafield
    const productRes = await admin.graphql(
      `#graphql
        query getProductAuction($id: ID!) {
          product(id: $id) {
            metafield(namespace: "auction", key: "settings") {
              value
            }
            variants(first: 1) {
              edges {
                node {
                  id
                  price
                  compareAtPrice
                }
              }
            }
          }
        }`,
      { variables: { id: productId } }
    );
    const productJson = await productRes.json();
    let currentSettings = {
      openingAuctionPrice: 0,
      reservePrice: 0,
      priceDropIntervalValue: 5,
      priceDropIntervalUnit: "Minutes",
      priceDrop: 0,
    };

    if (productJson.data?.product?.metafield?.value) {
      try {
        currentSettings = JSON.parse(productJson.data.product.metafield.value);
      } catch (e) {}
    }

    const updatedPayload = {
      ...currentSettings,
      isAuctionRunning: targetState,
      auctionStartTime: startTime,
    };

    const targetVariantId = variantId || productJson.data?.product?.variants?.edges?.[0]?.node?.id;

    // If starting auction, reset Shopify Variant Price to Opening Price & Compare Price
    if (targetState && targetVariantId && currentSettings.openingAuctionPrice > 0) {
      await admin.graphql(
        `#graphql
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
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
          }`,
        {
          variables: {
            productId: productId,
            variants: [
              {
                id: targetVariantId,
                price: currentSettings.openingAuctionPrice.toFixed(2),
                compareAtPrice: currentSettings.openingAuctionPrice.toFixed(2),
              },
            ],
          },
        }
      );
    }

    // 2. Save updated payload to Shopify Metafield
    const metafieldResponse = await admin.graphql(
      `#graphql
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              namespace
              key
              value
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          metafields: [
            {
              ownerId: productId,
              namespace: "auction",
              key: "settings",
              type: "json",
              value: JSON.stringify(updatedPayload),
            },
          ],
        },
      }
    );

    const metafieldJson = await metafieldResponse.json();
    const metafieldErrors = metafieldJson.data?.metafieldsSet?.userErrors || [];

    if (metafieldErrors.length > 0) {
      return {
        success: false,
        intent: "toggle_auction",
        error: metafieldErrors[0].message,
      };
    }

    return {
      success: true,
      intent: "toggle_auction",
      productId,
      isAuctionRunning: targetState,
      auctionStartTime: startTime,
      newPrice: targetState ? currentSettings.openingAuctionPrice.toFixed(2) : null,
      auction: {
        ...updatedPayload,
        isConfigured: true,
      },
    };
  }

  // Update Shopify Variant Price in Backend when price drops
  if (intent === "sync_auction_price") {
    const productId = formData.get("productId");
    const variantId = formData.get("variantId");
    const newPrice = parseFloat(formData.get("newPrice")) || 0;

    if (!productId || !variantId || newPrice <= 0) {
      return { success: false, error: "Invalid price sync params" };
    }

    const response = await admin.graphql(
      `#graphql
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id
              price
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          productId: productId,
          variants: [
            {
              id: variantId,
              price: newPrice.toFixed(2),
            },
          ],
        },
      }
    );

    const responseJson = await response.json();
    const userErrors = responseJson.data?.productVariantsBulkUpdate?.userErrors || [];

    if (userErrors.length > 0) {
      return {
        success: false,
        intent: "sync_auction_price",
        error: userErrors[0].message,
      };
    }

    return {
      success: true,
      intent: "sync_auction_price",
      productId,
      variantId,
      newPrice: newPrice.toFixed(2),
    };
  }

  if (intent === "save_product") {
    const productId = formData.get("productId");
    const variantId = formData.get("variantId");
    const title = formData.get("title");
    const openingAuctionPrice = parseFloat(formData.get("openingAuctionPrice")) || 0;
    const reservePrice = parseFloat(formData.get("reservePrice")) || 0;
    const priceDropIntervalValue = parseInt(formData.get("priceDropIntervalValue"), 10) || 1;
    const priceDropIntervalUnit = formData.get("priceDropIntervalUnit") || "Minutes";
    const priceDrop = parseFloat(formData.get("priceDrop")) || 0;

    // Convert selected unit (Seconds, Minutes, Hours, Days) to Hours for custom.drop_every_hours
    let dropEveryHours = priceDropIntervalValue;
    if (priceDropIntervalUnit === "Days") {
      dropEveryHours = priceDropIntervalValue * 24;
    } else if (priceDropIntervalUnit === "Minutes") {
      dropEveryHours = Math.max(1, Math.round(priceDropIntervalValue / 60));
    } else if (priceDropIntervalUnit === "Seconds") {
      dropEveryHours = Math.max(1, Math.round(priceDropIntervalValue / 3600));
    }

    // 1. Update product title in Shopify
    const shopifyResponse = await admin.graphql(
      `#graphql
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product {
              id
              title
              status
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          input: {
            id: productId,
            title: title,
          },
        },
      }
    );

    const shopifyJson = await shopifyResponse.json();
    const userErrors = shopifyJson.data?.productUpdate?.userErrors || [];

    if (userErrors.length > 0) {
      return {
        success: false,
        intent: "save_product",
        error: userErrors[0].message,
      };
    }

    // 2. Update Compare at Price of variant if variantId is provided
    if (variantId) {
      await admin.graphql(
        `#graphql
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants {
                id
                compareAtPrice
              }
              userErrors {
                field
                message
              }
            }
          }`,
        {
          variables: {
            productId: productId,
            variants: [
              {
                id: variantId,
                compareAtPrice: openingAuctionPrice.toFixed(2),
              },
            ],
          },
        }
      );
    }

    // Preserve isAuctionRunning & auctionStartTime if already set
    const productRes = await admin.graphql(
      `#graphql
        query getProductAuction($id: ID!) {
          product(id: $id) {
            metafield(namespace: "auction", key: "settings") {
              value
            }
          }
        }`,
      { variables: { id: productId } }
    );
    const productJson = await productRes.json();
    let isAuctionRunning = false;
    let auctionStartTime = null;
    if (productJson.data?.product?.metafield?.value) {
      try {
        const existing = JSON.parse(productJson.data.product.metafield.value);
        isAuctionRunning = existing.isAuctionRunning ?? false;
        auctionStartTime = existing.auctionStartTime ?? null;
      } catch (e) {}
    }

    // 3. Save / Update auction configuration & custom metafields
    const auctionPayload = {
      openingAuctionPrice,
      reservePrice,
      priceDropIntervalValue,
      priceDropIntervalUnit,
      priceDrop,
      isAuctionRunning,
      auctionStartTime,
    };

    const primaryMetafields = [
      {
        ownerId: productId,
        namespace: "auction",
        key: "settings",
        type: "json",
        value: JSON.stringify(auctionPayload),
      },
      {
        ownerId: productId,
        namespace: "custom",
        key: "reserve_price",
        type: "number_decimal",
        value: reservePrice.toFixed(2),
      },
      {
        ownerId: productId,
        namespace: "custom",
        key: "price_drop_amount",
        type: "number_decimal",
        value: priceDrop.toFixed(2),
      },
      {
        ownerId: productId,
        namespace: "custom",
        key: "drop_every_hours",
        type: "number_integer",
        value: dropEveryHours.toString(),
      },
    ];

    let metafieldResponse = await admin.graphql(
      `#graphql
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              namespace
              key
              value
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          metafields: primaryMetafields,
        },
      }
    );

    let metafieldJson = await metafieldResponse.json();
    let metafieldErrors = metafieldJson.data?.metafieldsSet?.userErrors || [];

    // Fallback if custom metafield definitions in Shopify use single_line_text_field type
    if (metafieldErrors.some((e) => e.message?.toLowerCase().includes("type"))) {
      const fallbackMetafields = [
        {
          ownerId: productId,
          namespace: "auction",
          key: "settings",
          type: "json",
          value: JSON.stringify(auctionPayload),
        },
        {
          ownerId: productId,
          namespace: "custom",
          key: "reserve_price",
          type: "single_line_text_field",
          value: reservePrice.toString(),
        },
        {
          ownerId: productId,
          namespace: "custom",
          key: "price_drop_amount",
          type: "single_line_text_field",
          value: priceDrop.toString(),
        },
        {
          ownerId: productId,
          namespace: "custom",
          key: "drop_every_hours",
          type: "single_line_text_field",
          value: dropEveryHours.toString(),
        },
      ];

      const fallbackResponse = await admin.graphql(
        `#graphql
          mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                id
              }
              userErrors {
                field
                message
              }
            }
          }`,
        {
          variables: {
            metafields: fallbackMetafields,
          },
        }
      );
      const fallbackJson = await fallbackResponse.json();
      metafieldErrors = fallbackJson.data?.metafieldsSet?.userErrors || [];
    }

    if (metafieldErrors.length > 0) {
      return {
        success: false,
        intent: "save_product",
        error: metafieldErrors[0].message,
      };
    }

    return {
      success: true,
      intent: "save_product",
      productId,
      variantId,
      title,
      compareAtPrice: openingAuctionPrice.toFixed(2),
      auction: {
        ...auctionPayload,
        isConfigured: true,
      },
    };
  }

  return { success: false, error: "Invalid intent" };
};

export default function Index() {
  const { products: initialProducts, pageInfo, search } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const syncFetcher = useFetcher();
  const [searchParams, setSearchParams] = useSearchParams();

  const [products, setProducts] = useState(initialProducts);
  const [searchInput, setSearchInput] = useState(search);
  const [toast, setToast] = useState(null);

  // Track synced prices to prevent duplicate requests
  const syncedPricesRef = useRef(new Map());

  // Timer tick for real-time live price drop countdown
  const [, setTick] = useState(Date.now());

  // Modal State
  const [editingProduct, setEditingProduct] = useState(null);
  const [modalForm, setModalForm] = useState({
    title: "",
    openingAuctionPrice: 0,
    reservePrice: 0,
    priceDropIntervalValue: 5,
    priceDropIntervalUnit: "Minutes",
    priceDrop: 0,
  });
  const [validationError, setValidationError] = useState("");

  // Sync loader products when page changes or search changes
  useEffect(() => {
    setProducts(initialProducts);
  }, [initialProducts]);

  // Real-time timer interval + Automatic Shopify Variant Price Sync when interval passes
  useEffect(() => {
    const hasRunningAuction = products.some((p) => p.auction?.isAuctionRunning);
    if (!hasRunningAuction) return;

    const timer = setInterval(() => {
      setTick(Date.now());

      // Check each running product to see if Shopify backend variant price needs to be updated
      products.forEach((product) => {
        if (!product.auction?.isAuctionRunning || !product.variantId) return;

        const liveState = calculateAuctionState(product.auction);
        const livePriceStr = liveState.currentPrice.toFixed(2);
        const lastSyncedPrice = syncedPricesRef.current.get(product.id);

        // If live price has changed compared to Shopify product price and hasn't been synced yet
        if (
          Math.abs(parseFloat(product.price) - liveState.currentPrice) >= 0.01 &&
          lastSyncedPrice !== livePriceStr &&
          syncFetcher.state === "idle"
        ) {
          syncedPricesRef.current.set(product.id, livePriceStr);
          syncFetcher.submit(
            {
              intent: "sync_auction_price",
              productId: product.id,
              variantId: product.variantId,
              newPrice: livePriceStr,
            },
            { method: "POST" }
          );
        }
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [products, syncFetcher]);

  // Handle API response from syncFetcher (Shopify backend variant price update)
  useEffect(() => {
    if (syncFetcher.data?.success && syncFetcher.data?.intent === "sync_auction_price") {
      setProducts((prev) =>
        prev.map((p) =>
          p.id === syncFetcher.data.productId
            ? { ...p, price: syncFetcher.data.newPrice }
            : p
        )
      );
    }
  }, [syncFetcher.data]);

  // Handle API response from main fetcher actions
  useEffect(() => {
    if (!fetcher.data) return;

    if (fetcher.data.success) {
      if (fetcher.data.intent === "status_change") {
        setProducts((prev) =>
          prev.map((p) =>
            p.id === fetcher.data.productId
              ? { ...p, status: fetcher.data.status }
              : p
          )
        );
        showToast(`Product status updated to ${fetcher.data.status}`, "success");
      } else if (fetcher.data.intent === "toggle_auction") {
        setProducts((prev) =>
          prev.map((p) =>
            p.id === fetcher.data.productId
              ? {
                  ...p,
                  price: fetcher.data.newPrice || p.price,
                  auction: {
                    ...p.auction,
                    ...fetcher.data.auction,
                    isAuctionRunning: fetcher.data.isAuctionRunning,
                    auctionStartTime: fetcher.data.auctionStartTime,
                  },
                }
              : p
          )
        );
        showToast(
          fetcher.data.isAuctionRunning
            ? "Auction STARTED - Shopify Product Variant Price drop active!"
            : "Auction STOPPED",
          "success"
        );
      } else if (fetcher.data.intent === "save_product") {
        setProducts((prev) =>
          prev.map((p) =>
            p.id === fetcher.data.productId
              ? {
                  ...p,
                  title: fetcher.data.title,
                  compareAtPrice: fetcher.data.compareAtPrice || p.compareAtPrice,
                  auction: fetcher.data.auction,
                }
              : p
          )
        );
        setEditingProduct(null);
        showToast("Product title, compare price, and custom metafields saved successfully", "success");
      }
    } else if (fetcher.data.error) {
      showToast(fetcher.data.error, "error");
    }
  }, [fetcher.data]);

  const showToast = (message, type = "success") => {
    setToast({ message, type });
    if (shopify?.toast?.show) {
      shopify.toast.show(message, { isError: type === "error" });
    }
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  // Open Edit Modal
  const handleOpenEditModal = (product) => {
    setEditingProduct(product);
    setValidationError("");

    // Default to Compare Price if set, otherwise price or existing auction opening price
    const defaultOpeningPrice =
      product.auction?.openingAuctionPrice > 0
        ? product.auction.openingAuctionPrice
        : parseFloat(product.compareAtPrice) || parseFloat(product.price) || 0;

    setModalForm({
      title: product.title || "",
      openingAuctionPrice: defaultOpeningPrice,
      reservePrice: product.auction?.reservePrice ?? 0,
      priceDropIntervalValue: product.auction?.priceDropIntervalValue ?? 5,
      priceDropIntervalUnit: product.auction?.priceDropIntervalUnit || "Minutes",
      priceDrop: product.auction?.priceDrop ?? 0,
    });
  };

  // Handle Status change (ACTIVE <-> DRAFT)
  const handleStatusChange = (productId, targetStatus) => {
    fetcher.submit(
      { intent: "status_change", productId, status: targetStatus },
      { method: "POST" }
    );
  };

  // Handle Auction Toggle (Start <-> Stop)
  const handleToggleAuction = (product, isRunning) => {
    fetcher.submit(
      {
        intent: "toggle_auction",
        productId: product.id,
        variantId: product.variantId,
        isAuctionRunning: isRunning ? "true" : "false",
      },
      { method: "POST" }
    );
  };

  // Save changes from Modal
  const handleSaveProduct = (e) => {
    e.preventDefault();
    setValidationError("");

    if (!modalForm.title.trim()) {
      setValidationError("Product title cannot be empty.");
      return;
    }

    if (modalForm.openingAuctionPrice < 0 || modalForm.reservePrice < 0) {
      setValidationError("Prices cannot be negative numbers.");
      return;
    }

    if (modalForm.priceDropIntervalValue < 1) {
      setValidationError("Price drop interval must be at least 1.");
      return;
    }

    if (modalForm.priceDrop < 0) {
      setValidationError("Price drop amount cannot be negative.");
      return;
    }

    fetcher.submit(
      {
        intent: "save_product",
        productId: editingProduct.id,
        variantId: editingProduct.variantId || "",
        title: modalForm.title,
        openingAuctionPrice: modalForm.openingAuctionPrice,
        reservePrice: modalForm.reservePrice,
        priceDropIntervalValue: modalForm.priceDropIntervalValue,
        priceDropIntervalUnit: modalForm.priceDropIntervalUnit,
        priceDrop: modalForm.priceDrop,
      },
      { method: "POST" }
    );
  };

  // Search handler
  const handleSearchSubmit = (e) => {
    e.preventDefault();
    const params = new URLSearchParams(searchParams);
    if (searchInput.trim()) {
      params.set("search", searchInput.trim());
    } else {
      params.delete("search");
    }
    params.delete("after");
    params.delete("before");
    setSearchParams(params);
  };

  // Pagination Handlers
  const handleNextPage = () => {
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("after", pageInfo.endCursor);
    params.delete("before");
    setSearchParams(params);
  };

  const handlePreviousPage = () => {
    if (!pageInfo.hasPreviousPage || !pageInfo.startCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("before", pageInfo.startCursor);
    params.delete("after");
    setSearchParams(params);
  };

  const isSaving =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "save_product";

  return (
    <div className="shopify-admin-app">
      {/* Toast Banner */}
      {toast && (
        <div className={`toast-banner ${toast.type}`}>
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} className="toast-close">
            ×
          </button>
        </div>
      )}

      {/* Main Container */}
      <div className="page-container">
        {/* Header */}
        <div className="page-header">
          <div className="header-title-group">
            <h1 className="page-title">Products</h1>
            <span className="product-count-badge">
              {products.length} products on page
            </span>
          </div>

          {/* Search Form */}
          <form onSubmit={handleSearchSubmit} className="search-form">
            <div className="search-input-wrapper">
              <svg className="search-icon" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
                  clipRule="evenodd"
                />
              </svg>
              <input
                type="text"
                placeholder="Search products by title..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="search-input"
              />
              {searchInput && (
                <button
                  type="button"
                  className="clear-search-btn"
                  onClick={() => {
                    setSearchInput("");
                    const params = new URLSearchParams(searchParams);
                    params.delete("search");
                    params.delete("after");
                    params.delete("before");
                    setSearchParams(params);
                  }}
                >
                  ×
                </button>
              )}
            </div>
            <button type="submit" className="btn btn-secondary">
              Search
            </button>
          </form>
        </div>

        {/* Product Table Card */}
        <div className="card">
          <div className="table-responsive">
            <table className="product-table">
              <thead>
                <tr>
                  <th style={{ width: "30%" }}>Product</th>
                  <th style={{ width: "12%" }}>Status</th>
                  <th style={{ width: "32%" }}>Shopify Live Auction &amp; Price Drop</th>
                  <th style={{ width: "26%", textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {products.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty-state">
                      <div className="empty-state-content">
                        <svg className="empty-icon" viewBox="0 0 20 20" fill="currentColor">
                          <path
                            fillRule="evenodd"
                            d="M10 2a8 8 0 100 16 8 8 0 000-16zM8 9a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1zm1 4a1 1 0 100 2 1 1 0 000-2z"
                            clipRule="evenodd"
                          />
                        </svg>
                        <p>No products found in store.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  products.map((product) => {
                    const isDraft = product.status === "DRAFT";
                    const isAuctionRunning = product.auction?.isAuctionRunning;

                    // Calculate live dropped price and countdown
                    const liveState = calculateAuctionState(product.auction);

                    const isCurrentlyChangingStatus =
                      fetcher.state !== "idle" &&
                      fetcher.formData?.get("intent") === "status_change" &&
                      fetcher.formData?.get("productId") === product.id;

                    const isCurrentlyTogglingAuction =
                      fetcher.state !== "idle" &&
                      fetcher.formData?.get("intent") === "toggle_auction" &&
                      fetcher.formData?.get("productId") === product.id;

                    return (
                      <tr key={product.id} className="product-row">
                        {/* Product Column */}
                        <td>
                          <div className="product-cell">
                            <div className="product-image-container">
                              {product.imageUrl ? (
                                <>
                                  <img
                                    src={product.imageUrl}
                                    alt={product.title}
                                    className="product-image"
                                  />
                                  {product.isVideo && (
                                    <div className="video-badge" title="Video media">
                                      <svg viewBox="0 0 20 20" fill="currentColor" className="video-play-icon">
                                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                                      </svg>
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div className="product-image-placeholder">
                                  <svg
                                    viewBox="0 0 20 20"
                                    fill="currentColor"
                                    className="placeholder-icon"
                                  >
                                    <path
                                      fillRule="evenodd"
                                      d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z"
                                      clipRule="evenodd"
                                    />
                                  </svg>
                                </div>
                              )}
                            </div>
                            <div className="product-info">
                              <span className="product-title-text">
                                {product.title}
                              </span>
                            </div>
                          </div>
                        </td>

                        {/* Status Column */}
                        <td>
                          <span
                            className={`status-badge ${
                              product.status === "ACTIVE"
                                ? "status-active"
                                : product.status === "DRAFT"
                                ? "status-draft"
                                : "status-other"
                            }`}
                          >
                            <span className="status-dot"></span>
                            {product.status}
                          </span>
                        </td>

                        {/* Auction Price / Settings Column with Live Price Drop */}
                        <td>
                          <div className="auction-info-box">
                            {/* Live Auction State Badge */}
                            <div className="auction-state-row">
                              {isAuctionRunning ? (
                                <span className="auction-badge running">
                                  <span className="pulse-dot"></span> Auction Running
                                </span>
                              ) : (
                                <span className="auction-badge stopped">
                                  ● Auction Stopped
                                </span>
                              )}
                            </div>

                            {/* Live Price Display */}
                            {isAuctionRunning ? (
                              <div className="live-price-box">
                                <div className="live-current-price">
                                  Shopify Variant Price: <strong>£{liveState.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                                </div>
                                {!liveState.hasReachedReserve ? (
                                  <div className="live-timer-text">
                                    Next drop: -£{product.auction.priceDrop} in <strong>{formatCountdown(liveState.nextDropInSeconds)}</strong>
                                  </div>
                                ) : (
                                  <div className="reserve-reached-text">
                                    ✓ Reserve limit reached (£{product.auction.reservePrice.toLocaleString()})
                                  </div>
                                )}
                                <div className="auction-details-text" style={{ marginTop: "2px" }}>
                                  Start: £{product.auction.openingAuctionPrice.toLocaleString()} &bull; Interval: {product.auction.priceDropIntervalValue} {product.auction.priceDropIntervalUnit}
                                </div>
                              </div>
                            ) : product.auction?.openingAuctionPrice > 0 ? (
                              <>
                                <div className="auction-main-price">
                                  <strong>£{product.auction.openingAuctionPrice.toLocaleString()}</strong>
                                  <span className="auction-subtext"> (Opening)</span>
                                </div>
                                <div className="auction-details-text">
                                  Reserve: £{product.auction.reservePrice.toLocaleString()} &bull; -£{product.auction.priceDrop} / {product.auction.priceDropIntervalValue} {product.auction.priceDropIntervalUnit}
                                </div>
                              </>
                            ) : (
                              <span className="auction-unconfigured">
                                Settings not configured
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Actions Column */}
                        <td style={{ textAlign: "right" }}>
                          <div className="actions-cell">
                            {/* Edit Button */}
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleOpenEditModal(product)}
                            >
                              Edit
                            </button>

                            {/* Status Toggle Button: Draft or Active */}
                            {isDraft ? (
                              <button
                                type="button"
                                className="btn btn-outline-success btn-sm"
                                disabled={isCurrentlyChangingStatus}
                                onClick={() => handleStatusChange(product.id, "ACTIVE")}
                              >
                                {isCurrentlyChangingStatus ? (
                                  <span className="spinner-inline"></span>
                                ) : (
                                  "Active"
                                )}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-outline-danger btn-sm"
                                disabled={isCurrentlyChangingStatus}
                                onClick={() => handleStatusChange(product.id, "DRAFT")}
                              >
                                {isCurrentlyChangingStatus ? (
                                  <span className="spinner-inline"></span>
                                ) : (
                                  "Draft"
                                )}
                              </button>
                            )}

                            {/* Start / Stop Auction Button */}
                            {isAuctionRunning ? (
                              <button
                                type="button"
                                className="btn btn-stop btn-sm"
                                disabled={isCurrentlyTogglingAuction}
                                onClick={() => handleToggleAuction(product, false)}
                              >
                                {isCurrentlyTogglingAuction ? (
                                  <span className="spinner-inline white"></span>
                                ) : (
                                  "Stop"
                                )}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-start btn-sm"
                                disabled={isCurrentlyTogglingAuction}
                                onClick={() => handleToggleAuction(product, true)}
                              >
                                {isCurrentlyTogglingAuction ? (
                                  <span className="spinner-inline white"></span>
                                ) : (
                                  "Start"
                                )}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          <div className="pagination-footer">
            <div className="pagination-info">
              Showing {products.length} products per page
            </div>

            <div className="pagination-controls">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!pageInfo.hasPreviousPage}
                onClick={handlePreviousPage}
              >
                &larr; Previous
              </button>

              <span className="page-indicator">
                Current Page
              </span>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!pageInfo.hasNextPage}
                onClick={handleNextPage}
              >
                Next &rarr;
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Edit Product Modal */}
      {editingProduct && (
        <div className="modal-backdrop" onClick={() => setEditingProduct(null)}>
          <div
            className="modal-container"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="modal-header">
              <h2 className="modal-title">Edit Product</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setEditingProduct(null)}
              >
                ×
              </button>
            </div>

            {/* Modal Body / Form */}
            <form onSubmit={handleSaveProduct}>
              <div className="modal-body">
                {validationError && (
                  <div className="alert-danger">{validationError}</div>
                )}

                {/* Product Title Input */}
                <div className="form-group">
                  <label className="form-label">Product Title</label>
                  <input
                    type="text"
                    className="form-control"
                    value={modalForm.title}
                    onChange={(e) =>
                      setModalForm({ ...modalForm, title: e.target.value })
                    }
                    placeholder="Enter product title"
                  />
                </div>

                {/* Opening Auction Price / Compare at Price */}
                <div className="form-group">
                  <label className="form-label">
                    Opening Auction Price (£) <span style={{ fontWeight: "normal", color: "#6d7175" }}>(Compare at Price)</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="form-control"
                    value={modalForm.openingAuctionPrice}
                    onChange={(e) =>
                      setModalForm({
                        ...modalForm,
                        openingAuctionPrice: e.target.value,
                      })
                    }
                    placeholder="e.g. 5000"
                  />
                  <div className="form-help-text">
                    This value pre-fills from &amp; updates the Shopify Compare at Price.
                  </div>
                </div>

                {/* Reserve Price */}
                <div className="form-group">
                  <label className="form-label">
                    Reserve Price (£) <span style={{ fontWeight: "normal", color: "#6d7175" }}>(custom.reserve_price)</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="form-control"
                    value={modalForm.reservePrice}
                    onChange={(e) =>
                      setModalForm({
                        ...modalForm,
                        reservePrice: e.target.value,
                      })
                    }
                    placeholder="e.g. 3000"
                  />
                </div>

                {/* Price Drop Interval */}
                <div className="form-group">
                  <label className="form-label">
                    Price Drop Interval <span style={{ fontWeight: "normal", color: "#6d7175" }}>(custom.drop_every_hours)</span>
                  </label>
                  <div className="input-group-row">
                    <input
                      type="number"
                      min="1"
                      className="form-control"
                      value={modalForm.priceDropIntervalValue}
                      onChange={(e) =>
                        setModalForm({
                          ...modalForm,
                          priceDropIntervalValue: e.target.value,
                        })
                      }
                      placeholder="e.g. 5"
                    />
                    <select
                      className="form-control form-select"
                      value={modalForm.priceDropIntervalUnit}
                      onChange={(e) =>
                        setModalForm({
                          ...modalForm,
                          priceDropIntervalUnit: e.target.value,
                        })
                      }
                    >
                      <option value="Seconds">Seconds</option>
                      <option value="Minutes">Minutes</option>
                      <option value="Hours">Hours</option>
                      <option value="Days">Days</option>
                    </select>
                  </div>
                  <div className="form-help-text">
                    Price drops every [ {modalForm.priceDropIntervalValue || 1} ] [ {modalForm.priceDropIntervalUnit} ] &bull; Saves as converted Hours in custom.drop_every_hours
                  </div>
                </div>

                {/* Price Drop Amount */}
                <div className="form-group">
                  <label className="form-label">
                    Price Drop Amount (£) <span style={{ fontWeight: "normal", color: "#6d7175" }}>(custom.price_drop_amount)</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="form-control"
                    value={modalForm.priceDrop}
                    onChange={(e) =>
                      setModalForm({
                        ...modalForm,
                        priceDrop: e.target.value,
                      })
                    }
                    placeholder="e.g. 50"
                  />
                </div>
              </div>

              {/* Modal Footer */}
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEditingProduct(null)}
                  disabled={isSaving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSaving}
                >
                  {isSaving ? (
                    <span className="btn-loading-content">
                      <span className="spinner-inline white"></span> Saving...
                    </span>
                  ) : (
                    "Save Changes"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Embedded Scoped Shopify Polaris CSS */}
      <style>{`
        :root {
          --p-color-bg-app: #f6f6f7;
          --p-color-bg-surface: #ffffff;
          --p-color-border: #e1e3e5;
          --p-color-text-main: #202223;
          --p-color-text-subdued: #6d7175;
          --p-color-primary: #008060;
          --p-color-primary-hover: #006e52;
          --p-color-danger: #d82c0d;
          --p-color-danger-hover: #bc2200;
          --p-font-family: -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        }

        .shopify-admin-app {
          font-family: var(--p-font-family);
          color: var(--p-color-text-main);
          background-color: var(--p-color-bg-app);
          min-height: 100vh;
          padding: 24px;
          box-sizing: border-box;
        }

        .page-container {
          max-width: 1100px;
          margin: 0 auto;
        }

        .page-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 16px;
          margin-bottom: 20px;
        }

        .header-title-group {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .page-title {
          font-size: 24px;
          font-weight: 700;
          margin: 0;
          color: var(--p-color-text-main);
        }

        .product-count-badge {
          background-color: #e4e5e7;
          color: #4a4d51;
          font-size: 12px;
          font-weight: 600;
          padding: 4px 10px;
          border-radius: 12px;
        }

        .search-form {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .search-input-wrapper {
          position: relative;
          display: flex;
          align-items: center;
          width: 280px;
        }

        .search-icon {
          position: absolute;
          left: 10px;
          width: 16px;
          height: 16px;
          color: var(--p-color-text-subdued);
        }

        .search-input {
          width: 100%;
          padding: 8px 30px 8px 32px;
          border: 1px solid var(--p-color-border);
          border-radius: 6px;
          font-size: 14px;
          background: #ffffff;
          outline: none;
          transition: border-color 0.15s ease;
        }

        .search-input:focus {
          border-color: var(--p-color-primary);
          box-shadow: 0 0 0 1px var(--p-color-primary);
        }

        .clear-search-btn {
          position: absolute;
          right: 8px;
          background: none;
          border: none;
          font-size: 16px;
          color: var(--p-color-text-subdued);
          cursor: pointer;
        }

        .card {
          background: var(--p-color-bg-surface);
          border: 1px solid var(--p-color-border);
          border-radius: 12px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
          overflow: hidden;
        }

        .table-responsive {
          width: 100%;
          overflow-x: auto;
        }

        .product-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
          font-size: 14px;
        }

        .product-table th {
          background: #fafbfb;
          color: var(--p-color-text-subdued);
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 12px 16px;
          border-bottom: 1px solid var(--p-color-border);
        }

        .product-row {
          border-bottom: 1px solid #f1f2f3;
          transition: background-color 0.15s ease;
        }

        .product-row:hover {
          background-color: #f9fafb;
        }

        .product-row td {
          padding: 14px 16px;
          vertical-align: middle;
        }

        .product-cell {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .product-image-container {
          position: relative;
          width: 44px;
          height: 44px;
          border-radius: 6px;
          border: 1px solid var(--p-color-border);
          overflow: hidden;
          background: #f4f5f7;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .product-image {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .video-badge {
          position: absolute;
          bottom: 2px;
          right: 2px;
          background: rgba(0, 0, 0, 0.7);
          color: #ffffff;
          border-radius: 50%;
          width: 14px;
          height: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .video-play-icon {
          width: 10px;
          height: 10px;
        }

        .product-image-placeholder {
          color: #a6acb2;
          width: 20px;
          height: 20px;
        }

        .placeholder-icon {
          width: 100%;
          height: 100%;
        }

        .product-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .product-title-text {
          font-weight: 600;
          color: var(--p-color-text-main);
          font-size: 14px;
        }

        .status-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
        }

        .status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
        }

        .status-active {
          background-color: #e6f4ea;
          color: #137333;
        }
        .status-active .status-dot {
          background-color: #137333;
        }

        .status-draft {
          background-color: #feefc3;
          color: #b06000;
        }
        .status-draft .status-dot {
          background-color: #b06000;
        }

        .status-other {
          background-color: #f1f3f4;
          color: #5f6368;
        }
        .status-other .status-dot {
          background-color: #5f6368;
        }

        .auction-info-box {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .auction-state-row {
          margin-bottom: 2px;
        }

        .auction-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 10px;
          text-transform: uppercase;
        }

        .auction-badge.running {
          background-color: #d1fae5;
          color: #047857;
        }

        .auction-badge.stopped {
          background-color: #f3f4f6;
          color: #6b7280;
        }

        .pulse-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background-color: #10b981;
          box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
          animation: pulse 1.5s infinite;
        }

        .live-price-box {
          background: #f0fdf4;
          border: 1px solid #bbf7d0;
          border-radius: 6px;
          padding: 8px 10px;
        }

        .live-current-price {
          font-size: 14px;
          color: #15803d;
        }

        .live-timer-text {
          font-size: 12px;
          color: #166534;
          margin-top: 2px;
        }

        .reserve-reached-text {
          font-size: 12px;
          color: #b45309;
          font-weight: 600;
          margin-top: 2px;
        }

        @keyframes pulse {
          0% {
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
          }
          70% {
            box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
          }
        }

        .auction-main-price {
          font-size: 14px;
          color: #111827;
        }

        .auction-subtext {
          font-size: 12px;
          color: var(--p-color-text-subdued);
          font-weight: normal;
        }

        .auction-details-text {
          font-size: 12px;
          color: #4b5563;
        }

        .auction-unconfigured {
          font-size: 13px;
          color: #9ca3af;
          font-style: italic;
        }

        .actions-cell {
          display: flex;
          gap: 6px;
          justify-content: flex-end;
          align-items: center;
        }

        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 8px 14px;
          font-size: 14px;
          font-weight: 600;
          border-radius: 6px;
          cursor: pointer;
          border: 1px solid transparent;
          transition: all 0.15s ease;
          outline: none;
        }

        .btn-sm {
          padding: 5px 10px;
          font-size: 13px;
        }

        .btn-primary {
          background-color: var(--p-color-primary);
          color: #ffffff;
        }
        .btn-primary:hover:not(:disabled) {
          background-color: var(--p-color-primary-hover);
        }

        .btn-secondary {
          background-color: #ffffff;
          color: var(--p-color-text-main);
          border-color: var(--p-color-border);
        }
        .btn-secondary:hover:not(:disabled) {
          background-color: #f6f6f7;
        }

        .btn-outline-success {
          background-color: #ffffff;
          color: #008060;
          border-color: #008060;
        }
        .btn-outline-success:hover:not(:disabled) {
          background-color: #f0fdf4;
          border-color: #006e52;
        }

        .btn-outline-danger {
          background-color: #ffffff;
          color: var(--p-color-danger);
          border-color: #f87171;
        }
        .btn-outline-danger:hover:not(:disabled) {
          background-color: #fef2f2;
          border-color: var(--p-color-danger);
        }

        .btn-start {
          background-color: #2563eb;
          color: #ffffff;
          border-color: #1d4ed8;
        }
        .btn-start:hover:not(:disabled) {
          background-color: #1d4ed8;
        }

        .btn-stop {
          background-color: #dc2626;
          color: #ffffff;
          border-color: #b91c1c;
        }
        .btn-stop:hover:not(:disabled) {
          background-color: #b91c1c;
        }

        .btn-disabled {
          background-color: #f3f4f6;
          color: #9ca3af;
          border-color: #e5e7eb;
          cursor: not-allowed;
        }

        .btn:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }

        .pagination-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 20px;
          background: #fafbfb;
          border-top: 1px solid var(--p-color-border);
        }

        .pagination-info {
          font-size: 13px;
          color: var(--p-color-text-subdued);
        }

        .pagination-controls {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .page-indicator {
          font-size: 13px;
          font-weight: 600;
          color: var(--p-color-text-main);
        }

        /* Modal Styles */
        .modal-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(0, 0, 0, 0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 16px;
        }

        .modal-container {
          background: #ffffff;
          border-radius: 12px;
          width: 100%;
          max-width: 520px;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
          overflow: hidden;
          animation: modalFadeIn 0.2s ease-out;
        }

        @keyframes modalFadeIn {
          from { opacity: 0; transform: scale(0.97); }
          to { opacity: 1; transform: scale(1); }
        }

        .modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--p-color-border);
        }

        .modal-title {
          font-size: 18px;
          font-weight: 700;
          margin: 0;
        }

        .modal-close-btn {
          background: none;
          border: none;
          font-size: 24px;
          color: var(--p-color-text-subdued);
          cursor: pointer;
          line-height: 1;
        }

        .modal-body {
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          max-height: 70vh;
          overflow-y: auto;
        }

        .form-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .form-label {
          font-size: 13px;
          font-weight: 600;
          color: var(--p-color-text-main);
        }

        .form-control {
          width: 100%;
          padding: 9px 12px;
          border: 1px solid var(--p-color-border);
          border-radius: 6px;
          font-size: 14px;
          box-sizing: border-box;
          outline: none;
          transition: border-color 0.15s ease;
        }

        .form-control:focus {
          border-color: var(--p-color-primary);
          box-shadow: 0 0 0 1px var(--p-color-primary);
        }

        .input-group-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }

        .form-select {
          background-color: #ffffff;
          cursor: pointer;
        }

        .form-help-text {
          font-size: 12px;
          color: var(--p-color-text-subdued);
          font-style: italic;
          margin-top: 2px;
        }

        .modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          padding: 16px 20px;
          background: #fafbfb;
          border-top: 1px solid var(--p-color-border);
        }

        .alert-danger {
          background: #fef2f2;
          color: #991b1b;
          border: 1px solid #fecaca;
          padding: 10px 14px;
          border-radius: 6px;
          font-size: 13px;
        }

        .toast-banner {
          position: fixed;
          top: 20px;
          right: 20px;
          z-index: 1100;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 18px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
        }

        .toast-banner.success {
          background-color: #10b981;
          color: #ffffff;
        }

        .toast-banner.error {
          background-color: #ef4444;
          color: #ffffff;
        }

        .toast-close {
          background: none;
          border: none;
          color: #ffffff;
          font-size: 18px;
          cursor: pointer;
        }

        .spinner-inline {
          display: inline-block;
          width: 14px;
          height: 14px;
          border: 2px solid rgba(0, 0, 0, 0.2);
          border-left-color: currentColor;
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
        }

        .spinner-inline.white {
          border-color: rgba(255, 255, 255, 0.4);
          border-left-color: #ffffff;
        }

        .btn-loading-content {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .empty-state {
          padding: 48px 16px;
          text-align: center;
        }

        .empty-state-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          color: var(--p-color-text-subdued);
        }

        .empty-icon {
          width: 36px;
          height: 36px;
          color: #d1d5db;
        }
      `}</style>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div style={{ padding: "40px", fontFamily: "sans-serif" }}>
      <h2 style={{ color: "#d82c0d" }}>Error Loading Products</h2>
      <p style={{ color: "#5c5f62" }}>
        {error?.message || "An unexpected error occurred while communicating with Shopify."}
      </p>
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
