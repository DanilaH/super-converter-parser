export const SURFER_PARSER_VERSION = '2.0.0';

export const SURFER_MARKERS = {
  cssMarker: '.keyword-surfer',
  mainWidget: '.surfer-main-keyword-widget',
  // Keyword Surfer renders the related-keywords table inside the main Google
  // DOM (the keyword-surfer-sidebar element), NOT inside an iframe. The
  // assets.keywordsur.fr iframes only carry promotional title/content/buttons.
  relatedWidget: '.keyword-surfer-sidebar',
};

export type SurferSelectors = {
  mainWidget: string;
  relatedWidget: string;
};