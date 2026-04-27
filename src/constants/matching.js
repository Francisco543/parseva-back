/**
 * @file Constantes para matching/correlación entre documentos.
 * @module constants/matching
 */

/**
 * Estados de un `DocumentLink`.
 *
 * @typedef {(typeof DOCUMENT_LINK_STATUS)[keyof typeof DOCUMENT_LINK_STATUS]} DocumentLinkStatus
 */
const DOCUMENT_LINK_STATUS = Object.freeze({
  MATCHED: "MATCHED",
  PARTIAL_MATCH: "PARTIAL_MATCH",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  REJECTED: "REJECTED",
});

/**
 * Estrategias de match disponibles para `MatchRule.strategy`.
 *
 * @typedef {(typeof MATCH_STRATEGY)[keyof typeof MATCH_STRATEGY]} MatchStrategy
 */
const MATCH_STRATEGY = Object.freeze({
  EXACT: "exact",
  FUZZY: "fuzzy",
  AI_SEMANTIC: "ai_semantic",
});

/**
 * Cardinalidades de la relación entre documentos relacionados.
 *
 * @typedef {(typeof RELATION_CARDINALITY)[keyof typeof RELATION_CARDINALITY]} RelationCardinality
 */
const RELATION_CARDINALITY = Object.freeze({
  ONE_TO_ONE: "ONE_TO_ONE",
  ONE_TO_MANY: "ONE_TO_MANY",
  MANY_TO_ONE: "MANY_TO_ONE",
  MANY_TO_MANY: "MANY_TO_MANY",
});

/**
 * `linkType` por defecto para correlaciones automáticas.
 */
const AUTO_CORRELATION_LINK_TYPE = "correlation_auto";

module.exports = {
  DOCUMENT_LINK_STATUS,
  MATCH_STRATEGY,
  RELATION_CARDINALITY,
  AUTO_CORRELATION_LINK_TYPE,
};
