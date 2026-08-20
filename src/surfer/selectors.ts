export const SURFER_PARSER_VERSION = '2.1.0';

export const SURFER_MARKERS = {
  cssMarker: '.keyword-surfer',
  mainWidget: '.surfer-main-keyword-widget',
  // `keyword-surfer-sidebar` is the custom-element tag name in the main Google
  // document. `.keyword-surfer-sidebar` would incorrectly look for a class.
  relatedWidget: 'keyword-surfer-sidebar',
};

export type SurferSelectors = {
  mainWidget: string;
  relatedWidget: string;
};
