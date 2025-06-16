const { v4: uuidv4 } = require('uuid');
const { logger, logError } = require('../utils/logger');

/**
 * Graph Database Service
 * Handles knowledge graph operations including entity and relationship management
 */
class GraphDatabaseService {
  constructor(database) {
    this.database = database;
  }

  /**
   * Create or update an entity in the knowledge graph
   */
  async createEntity(entityData) {
    try {
      // Check if entity already exists with same name and type for this persona
      const existingEntity = await this.findEntityByNameAndType(
        entityData.personaId,
        entityData.name,
        entityData.type
      );

      if (existingEntity) {
        // Update existing entity with higher confidence if provided
        if (entityData.confidence > existingEntity.confidence) {
          await this.updateEntity(existingEntity.id, {
            confidence: entityData.confidence,
            vectorId: entityData.vectorId || existingEntity.vector_id,
            properties: {
              ...existingEntity.properties,
              ...entityData.properties
            }
          });
          
          logger.info('Updated existing entity with higher confidence', {
            entityId: existingEntity.id,
            name: entityData.name,
            oldConfidence: existingEntity.confidence,
            newConfidence: entityData.confidence
          });
          
          return existingEntity.id;
        } else {
          // Entity exists with equal or higher confidence, return existing ID
          return existingEntity.id;
        }
      }

      // Create new entity
      const entityId = entityData.id || uuidv4();
      await this.database.insertEntity({
        id: entityId,
        personaId: entityData.personaId,
        vectorId: entityData.vectorId,
        type: entityData.type,
        name: entityData.name,
        properties: entityData.properties || {},
        confidence: entityData.confidence || 1.0
      });

      logger.info('Created new entity', {
        entityId,
        personaId: entityData.personaId,
        type: entityData.type,
        name: entityData.name,
        confidence: entityData.confidence
      });

      return entityId;

    } catch (error) {
      logError(error, {
        operation: 'createEntity',
        entityData: {
          personaId: entityData.personaId,
          type: entityData.type,
          name: entityData.name
        }
      });
      throw error;
    }
  }

  /**
   * Create or update a relationship between entities
   */
  async createRelationship(relationshipData) {
    try {
      // Check if relationship already exists
      const existingRelationship = await this.findRelationship(
        relationshipData.sourceEntityId,
        relationshipData.targetEntityId,
        relationshipData.relationshipType
      );

      if (existingRelationship) {
        // Update relationship strength using weighted average
        const newStrength = (existingRelationship.strength + relationshipData.strength) / 2;
        
        await this.database.updateRelationship(existingRelationship.id, {
          strength: newStrength,
          context: relationshipData.context || existingRelationship.context,
          properties: {
            ...existingRelationship.properties,
            ...relationshipData.properties,
            updateCount: (existingRelationship.properties.updateCount || 0) + 1
          }
        });

        logger.info('Updated existing relationship', {
          relationshipId: existingRelationship.id,
          oldStrength: existingRelationship.strength,
          newStrength: newStrength
        });

        return existingRelationship.id;
      }

      // Create new relationship
      const relationshipId = relationshipData.id || uuidv4();
      await this.database.insertRelationship({
        id: relationshipId,
        personaId: relationshipData.personaId,
        sourceEntityId: relationshipData.sourceEntityId,
        targetEntityId: relationshipData.targetEntityId,
        relationshipType: relationshipData.relationshipType,
        strength: relationshipData.strength || 1.0,
        context: relationshipData.context,
        properties: relationshipData.properties || {}
      });

      logger.info('Created new relationship', {
        relationshipId,
        personaId: relationshipData.personaId,
        sourceEntityId: relationshipData.sourceEntityId,
        targetEntityId: relationshipData.targetEntityId,
        relationshipType: relationshipData.relationshipType,
        strength: relationshipData.strength
      });

      return relationshipId;

    } catch (error) {
      logError(error, {
        operation: 'createRelationship',
        relationshipData: {
          personaId: relationshipData.personaId,
          sourceEntityId: relationshipData.sourceEntityId,
          targetEntityId: relationshipData.targetEntityId,
          relationshipType: relationshipData.relationshipType
        }
      });
      throw error;
    }
  }

  /**
   * Process extracted entities and relationships from content
   */
  async processEntitiesAndRelationships(entities, relationships) {
    try {
      const processedEntities = [];
      const processedRelationships = [];

      // Process entities first
      for (const entity of entities) {
        try {
          const entityId = await this.createEntity(entity);
          processedEntities.push({
            ...entity,
            id: entityId,
            status: 'processed'
          });
        } catch (error) {
          logError(error, {
            operation: 'processEntity',
            entityName: entity.name,
            entityType: entity.type
          });
          processedEntities.push({
            ...entity,
            status: 'failed',
            error: error.message
          });
        }
      }

      // Process relationships after entities are created
      for (const relationship of relationships) {
        try {
          const relationshipId = await this.createRelationship(relationship);
          processedRelationships.push({
            ...relationship,
            id: relationshipId,
            status: 'processed'
          });
        } catch (error) {
          logError(error, {
            operation: 'processRelationship',
            sourceEntityId: relationship.sourceEntityId,
            targetEntityId: relationship.targetEntityId,
            relationshipType: relationship.relationshipType
          });
          processedRelationships.push({
            ...relationship,
            status: 'failed',
            error: error.message
          });
        }
      }

      const summary = {
        entitiesProcessed: processedEntities.filter(e => e.status === 'processed').length,
        entitiesFailed: processedEntities.filter(e => e.status === 'failed').length,
        relationshipsProcessed: processedRelationships.filter(r => r.status === 'processed').length,
        relationshipsFailed: processedRelationships.filter(r => r.status === 'failed').length
      };

      logger.info('Graph processing completed', summary);

      return {
        entities: processedEntities,
        relationships: processedRelationships,
        summary
      };

    } catch (error) {
      logError(error, {
        operation: 'processEntitiesAndRelationships',
        entityCount: entities?.length,
        relationshipCount: relationships?.length
      });
      throw error;
    }
  }

  /**
   * Find related entities using graph traversal
   */
  async findRelatedEntities(entityId, options = {}) {
    try {
      const {
        maxDepth = 2,
        limit = 50,
        minStrength = 0.1,
        entityTypes = null,
        relationshipTypes = null
      } = options;

      // Use database's graph traversal method
      const relatedEntities = await this.database.findRelatedEntities(entityId, maxDepth, limit);

      // Filter by entity types if specified
      let filteredEntities = relatedEntities;
      if (entityTypes && Array.isArray(entityTypes)) {
        filteredEntities = filteredEntities.filter(entity => 
          entityTypes.includes(entity.type)
        );
      }

      // Filter by minimum confidence (using confidence as a proxy for strength)
      if (minStrength > 0) {
        filteredEntities = filteredEntities.filter(entity => 
          entity.confidence >= minStrength
        );
      }

      // Get relationship information for each related entity
      const enrichedEntities = await Promise.all(
        filteredEntities.map(async (entity) => {
          try {
            const relationships = await this.database.getEntityRelationships(entity.entity_id, 'both', 5);
            
            // Filter relationships if types specified
            let filteredRelationships = relationships;
            if (relationshipTypes && Array.isArray(relationshipTypes)) {
              filteredRelationships = relationships.filter(rel => 
                relationshipTypes.includes(rel.relationship_type)
              );
            }

            return {
              id: entity.entity_id,
              name: entity.name,
              type: entity.type,
              confidence: entity.confidence,
              depth: entity.depth,
              relationships: filteredRelationships.map(rel => ({
                id: rel.id,
                type: rel.relationship_type,
                strength: rel.strength,
                direction: rel.source_entity_id === entity.entity_id ? 'outgoing' : 'incoming',
                connectedEntityId: rel.source_entity_id === entity.entity_id ? rel.target_entity_id : rel.source_entity_id
              }))
            };
          } catch (error) {
            logError(error, {
              operation: 'enrichRelatedEntity',
              entityId: entity.entity_id
            });
            return {
              id: entity.entity_id,
              name: entity.name,
              type: entity.type,
              confidence: entity.confidence,
              depth: entity.depth,
              relationships: []
            };
          }
        })
      );

      logger.info('Found related entities', {
        sourceEntityId: entityId,
        relatedCount: enrichedEntities.length,
        maxDepth,
        options
      });

      return enrichedEntities;

    } catch (error) {
      logError(error, {
        operation: 'findRelatedEntities',
        entityId,
        options
      });
      return [];
    }
  }

  /**
   * Get knowledge graph context for entities
   */
  async getGraphContext(entityIds, options = {}) {
    try {
      const {
        includeRelationships = true,
        maxRelationships = 10,
        relationshipDepth = 1
      } = options;

      const context = {
        entities: [],
        relationships: [],
        connections: []
      };

      // Get detailed information for each entity
      for (const entityId of entityIds) {
        try {
          const entity = await this.database.getEntityById(entityId);
          if (entity) {
            context.entities.push(entity);

            if (includeRelationships) {
              const relationships = await this.database.getEntityRelationships(
                entityId, 
                'both', 
                maxRelationships
              );
              
              context.relationships.push(...relationships);

              // Find connections between the requested entities
              const connections = relationships.filter(rel => 
                entityIds.includes(rel.source_entity_id) || 
                entityIds.includes(rel.target_entity_id)
              );
              
              context.connections.push(...connections);
            }
          }
        } catch (error) {
          logError(error, {
            operation: 'getEntityContext',
            entityId
          });
        }
      }

      // Remove duplicate relationships
      context.relationships = this.deduplicateRelationships(context.relationships);
      context.connections = this.deduplicateRelationships(context.connections);

      logger.info('Retrieved graph context', {
        requestedEntities: entityIds.length,
        foundEntities: context.entities.length,
        relationships: context.relationships.length,
        connections: context.connections.length
      });

      return context;

    } catch (error) {
      logError(error, {
        operation: 'getGraphContext',
        entityIds
      });
      return { entities: [], relationships: [], connections: [] };
    }
  }

  /**
   * Search entities by similarity to query terms
   */
  async searchEntities(personaId, query, options = {}) {
    try {
      const {
        limit = 10,
        entityTypes = null,
        minConfidence = 0.0
      } = options;

      // Simple text-based search for now (could be enhanced with semantic search later)
      const searchTerms = query.toLowerCase().split(/\s+/);
      let allEntities = await this.database.getEntitiesByPersona(personaId, {
        limit: 1000 // Get more for filtering
      });

      // Filter by entity types if specified
      if (entityTypes && Array.isArray(entityTypes)) {
        allEntities = allEntities.filter(entity => 
          entityTypes.includes(entity.type)
        );
      }

      // Filter by minimum confidence
      allEntities = allEntities.filter(entity => 
        entity.confidence >= minConfidence
      );

      // Score entities based on query similarity
      const scoredEntities = allEntities.map(entity => {
        const name = entity.name.toLowerCase();
        let score = 0;

        // Exact match gets highest score
        if (name === query.toLowerCase()) {
          score = 1.0;
        } else {
          // Partial matches
          for (const term of searchTerms) {
            if (name.includes(term)) {
              score += 0.5 / searchTerms.length;
            }
            // Word boundary matches get higher score
            if (name.match(new RegExp(`\\b${term}\\b`))) {
              score += 0.3 / searchTerms.length;
            }
          }
        }

        // Boost score by entity confidence
        score *= entity.confidence;

        return {
          ...entity,
          searchScore: score
        };
      });

      // Sort by search score and limit results
      const results = scoredEntities
        .filter(entity => entity.searchScore > 0)
        .sort((a, b) => b.searchScore - a.searchScore)
        .slice(0, limit);

      logger.info('Entity search completed', {
        personaId,
        query,
        resultsFound: results.length,
        totalSearched: allEntities.length
      });

      return results;

    } catch (error) {
      logError(error, {
        operation: 'searchEntities',
        personaId,
        query
      });
      return [];
    }
  }

  /**
   * Get knowledge graph statistics for a persona
   */
  async getGraphStatistics(personaId) {
    try {
      const stats = await this.database.getGraphStats(personaId);
      
      // Add additional derived statistics
      const totalNodes = stats.totalEntities;
      const totalEdges = stats.totalRelationships;
      const density = totalNodes > 1 ? (2 * totalEdges) / (totalNodes * (totalNodes - 1)) : 0;
      
      // Calculate average relationships per entity
      const avgRelationshipsPerEntity = totalNodes > 0 ? totalEdges / totalNodes : 0;

      const enhancedStats = {
        ...stats,
        graphDensity: parseFloat(density.toFixed(4)),
        averageRelationshipsPerEntity: parseFloat(avgRelationshipsPerEntity.toFixed(2)),
        graphComplexity: this.calculateGraphComplexity(stats),
        lastUpdated: Date.now()
      };

      logger.info('Retrieved graph statistics', {
        personaId,
        totalEntities: stats.totalEntities,
        totalRelationships: stats.totalRelationships,
        graphDensity: enhancedStats.graphDensity
      });

      return enhancedStats;

    } catch (error) {
      logError(error, {
        operation: 'getGraphStatistics',
        personaId
      });
      return {
        totalEntities: 0,
        totalRelationships: 0,
        entityTypes: [],
        relationshipTypes: [],
        graphDensity: 0,
        averageRelationshipsPerEntity: 0,
        graphComplexity: 'low',
        lastUpdated: Date.now()
      };
    }
  }

  /**
   * Helper method to find entity by name and type
   */
  async findEntityByNameAndType(personaId, name, type) {
    try {
      const entities = await this.database.searchEntitiesByName(personaId, name, 5);
      return entities.find(entity => 
        entity.type === type && 
        entity.name.toLowerCase() === name.toLowerCase()
      );
    } catch (error) {
      logError(error, {
        operation: 'findEntityByNameAndType',
        personaId,
        name,
        type
      });
      return null;
    }
  }

  /**
   * Helper method to find existing relationship
   */
  async findRelationship(sourceEntityId, targetEntityId, relationshipType) {
    try {
      const relationships = await this.database.getEntityRelationships(sourceEntityId, 'outgoing', 100);
      return relationships.find(rel => 
        rel.target_entity_id === targetEntityId && 
        rel.relationship_type === relationshipType
      );
    } catch (error) {
      logError(error, {
        operation: 'findRelationship',
        sourceEntityId,
        targetEntityId,
        relationshipType
      });
      return null;
    }
  }

  /**
   * Helper method to update entity
   */
  async updateEntity(entityId, updates) {
    try {
      await this.database.updateEntity(entityId, updates);
      logger.debug('Entity updated', { entityId, updates });
    } catch (error) {
      logError(error, {
        operation: 'updateEntity',
        entityId,
        updates
      });
      throw error;
    }
  }

  /**
   * Helper method to deduplicate relationships
   */
  deduplicateRelationships(relationships) {
    const seen = new Set();
    return relationships.filter(rel => {
      const key = `${rel.source_entity_id}-${rel.target_entity_id}-${rel.relationship_type}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * Calculate graph complexity based on statistics
   */
  calculateGraphComplexity(stats) {
    const totalEntities = stats.totalEntities;
    const totalRelationships = stats.totalRelationships;
    const entityTypeCount = stats.entityTypes.length;
    const relationshipTypeCount = stats.relationshipTypes.length;

    if (totalEntities < 10) return 'low';
    if (totalEntities < 50) return 'medium';
    if (totalEntities < 200) return 'high';
    return 'very_high';
  }

  /**
   * Clean up orphaned entities (entities with no relationships)
   */
  async cleanupOrphanedEntities(personaId, maxAge = 30 * 24 * 60 * 60 * 1000) { // 30 days
    try {
      const cutoffTime = Date.now() - maxAge;
      let cleanedCount = 0;

      // Get all entities for the persona
      const entities = await this.database.getEntitiesByPersona(personaId);

      for (const entity of entities) {
        // Skip if entity is recent
        if (entity.created_at > cutoffTime) continue;

        // Check if entity has any relationships
        const relationships = await this.database.getEntityRelationships(entity.id, 'both', 1);
        
        // If no relationships and entity is old, consider for cleanup
        if (relationships.length === 0 && entity.confidence < 0.5) {
          await this.database.deleteEntity(entity.id);
          cleanedCount++;
        }
      }

      logger.info('Cleaned up orphaned entities', {
        personaId,
        cleanedCount,
        maxAge
      });

      return cleanedCount;

    } catch (error) {
      logError(error, {
        operation: 'cleanupOrphanedEntities',
        personaId
      });
      return 0;
    }
  }
}

module.exports = GraphDatabaseService;
