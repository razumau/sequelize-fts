'use strict';

/* jshint -W110 */
var Utils = require('../../utils')
  , DataTypes = require('../../data-types')
  , AbstractQueryGenerator = require('../abstract/query-generator')
  , randomBytes = require('crypto').randomBytes
  , semver = require('semver');

/* istanbul ignore next */
var throwMethodUndefined = function(methodName) {
  throw new Error('The method "' + methodName + '" is not defined! Please add it to your sql dialect.');
};

var QueryGenerator = {
  options: {},
  dialect: 'mssql',

  createSchema: function(schema) {
    return [
      'IF NOT EXISTS (SELECT schema_name',
      'FROM information_schema.schemata',
      'WHERE schema_name =', wrapSingleQuote(schema), ')',
      'BEGIN',
        "EXEC sp_executesql N'CREATE SCHEMA",
        this.quoteIdentifier(schema),
        ";'",
      'END;'
    ].join(' ');
  },

  showSchemasQuery: function() {
    return [
      'SELECT "name" as "schema_name" FROM sys.schemas as s',
      'WHERE "s"."name" NOT IN (',
        "'INFORMATION_SCHEMA', 'dbo', 'guest', 'sys', 'archive'",
      ')', 'AND', '"s"."name" NOT LIKE', "'db_%'"
    ].join(' ');
  },

  versionQuery: function() {
    // Uses string manipulation to convert the MS Maj.Min.Patch.Build to semver Maj.Min.Patch
    return [
      'DECLARE @ms_ver NVARCHAR(20);',
      "SET @ms_ver = REVERSE(CONVERT(NVARCHAR(20), SERVERPROPERTY('ProductVersion')));",
      "SELECT REVERSE(SUBSTRING(@ms_ver, CHARINDEX('.', @ms_ver)+1, 20)) AS 'version'"
    ].join(' ');
  },

  createTableQuery: function(tableName, attributes, options) {
    var query = "IF OBJECT_ID('<%= table %>', 'U') IS NULL CREATE TABLE <%= table %> (<%= attributes %>)"
      , primaryKeys = []
      , foreignKeys = {}
      , attrStr = []
      , self = this;

    for (var attr in attributes) {
      if (attributes.hasOwnProperty(attr)) {
        var dataType = attributes[attr]
          , match;

        if (Utils._.includes(dataType, 'PRIMARY KEY')) {
          primaryKeys.push(attr);

          if (Utils._.includes(dataType, 'REFERENCES')) {
             // MSSQL doesn't support inline REFERENCES declarations: move to the end
            match = dataType.match(/^(.+) (REFERENCES.*)$/);
            attrStr.push(this.quoteIdentifier(attr) + ' ' + match[1].replace(/PRIMARY KEY/, ''));
            foreignKeys[attr] = match[2];
          } else {
            attrStr.push(this.quoteIdentifier(attr) + ' ' + dataType.replace(/PRIMARY KEY/, ''));
          }
        } else if (Utils._.includes(dataType, 'REFERENCES')) {
          // MSSQL doesn't support inline REFERENCES declarations: move to the end
          match = dataType.match(/^(.+) (REFERENCES.*)$/);
          attrStr.push(this.quoteIdentifier(attr) + ' ' + match[1]);
          foreignKeys[attr] = match[2];
        } else {
          attrStr.push(this.quoteIdentifier(attr) + ' ' + dataType);
        }
      }
    }

    var values = {
      table: this.quoteTable(tableName),
      attributes: attrStr.join(', '),
    }
    , pkString = primaryKeys.map(function(pk) { return this.quoteIdentifier(pk); }.bind(this)).join(', ');

    if (!!options.uniqueKeys) {
      Utils._.each(options.uniqueKeys, function(columns, indexName) {
        if (!Utils._.isString(indexName)) {
          indexName = 'uniq_' + tableName + '_' + columns.fields.join('_');
        }
        values.attributes += ', CONSTRAINT ' + self.quoteIdentifier(indexName) + ' UNIQUE (' + Utils._.map(columns.fields, self.quoteIdentifier).join(', ') + ')';
      });
    }

    if (pkString.length > 0) {
      values.attributes += ', PRIMARY KEY (' + pkString + ')';
    }

    for (var fkey in foreignKeys) {
      if (foreignKeys.hasOwnProperty(fkey)) {
        values.attributes += ', FOREIGN KEY (' + this.quoteIdentifier(fkey) + ') ' + foreignKeys[fkey];
      }
    }

    return Utils._.template(query)(values).trim() + ';';
  },

  describeTableQuery: function(tableName, schema) {
    var sql = [
      'SELECT',
        "c.COLUMN_NAME AS 'Name',",
        "c.DATA_TYPE AS 'Type',",
        "c.CHARACTER_MAXIMUM_LENGTH AS 'Length',",
        "c.IS_NULLABLE as 'IsNull',",
        "COLUMN_DEFAULT AS 'Default',",
        "tc.CONSTRAINT_TYPE AS 'Constraint'",
      'FROM',
        'INFORMATION_SCHEMA.TABLES t',
      'INNER JOIN',
        'INFORMATION_SCHEMA.COLUMNS c ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_SCHEMA = c.TABLE_SCHEMA',
      'LEFT JOIN',
        'INFORMATION_SCHEMA.KEY_COLUMN_USAGE cu ON t.TABLE_NAME = cu.TABLE_NAME AND cu.COLUMN_NAME = c.COLUMN_NAME AND t.TABLE_SCHEMA = cu.TABLE_SCHEMA',
      'LEFT JOIN',
        'INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON t.TABLE_NAME = tc.TABLE_NAME AND cu.COLUMN_NAME = c.COLUMN_NAME AND tc.CONSTRAINT_TYPE = \'PRIMARY KEY\'',
      'WHERE t.TABLE_NAME =', wrapSingleQuote(tableName)
    ].join(' ');

    if (schema) {
      sql += 'AND t.TABLE_SCHEMA =' + wrapSingleQuote(schema);
    }

    return sql;
  },

  renameTableQuery: function(before, after) {
    var query = 'EXEC sp_rename <%= before %>, <%= after %>;';
    return Utils._.template(query)({
      before: this.quoteTable(before),
      after: this.quoteTable(after)
    });
  },

  showTablesQuery: function () {
    return 'SELECT TABLE_NAME, TABLE_SCHEMA FROM INFORMATION_SCHEMA.TABLES;';
  },

  dropTableQuery: function(tableName) {
    var query = "IF OBJECT_ID('<%= table %>', 'U') IS NOT NULL DROP TABLE <%= table %>";
    var values = {
      table: this.quoteTable(tableName)
    };

    return Utils._.template(query)(values).trim() + ';';
  },

  addColumnQuery: function(table, key, dataType) {
    // FIXME: attributeToSQL SHOULD be using attributes in addColumnQuery
    //        but instead we need to pass the key along as the field here
    dataType.field = key;

    var query = 'ALTER TABLE <%= table %> ADD <%= attribute %>;'
      , attribute = Utils._.template('<%= key %> <%= definition %>')({
        key: this.quoteIdentifier(key),
        definition: this.attributeToSQL(dataType, {
          context: 'addColumn'
        })
      });

    return Utils._.template(query)({
      table: this.quoteTable(table),
      attribute: attribute
    });
  },

  removeColumnQuery: function(tableName, attributeName) {
    var query = 'ALTER TABLE <%= tableName %> DROP COLUMN <%= attributeName %>;';
    return Utils._.template(query)({
      tableName: this.quoteTable(tableName),
      attributeName: this.quoteIdentifier(attributeName)
    });
  },

  changeColumnQuery: function(tableName, attributes) {
    var query = 'ALTER TABLE <%= tableName %> <%= query %>;';
    var attrString = [], constraintString = [];

    for (var attributeName in attributes) {
      var definition = attributes[attributeName];
      if (definition.match(/REFERENCES/)) {
        constraintString.push(Utils._.template('<%= fkName %> FOREIGN KEY (<%= attrName %>) <%= definition %>')({
          fkName: this.quoteIdentifier(attributeName + '_foreign_idx'),
          attrName: this.quoteIdentifier(attributeName),
          definition: definition.replace(/.+?(?=REFERENCES)/,'')
        }));
      } else {
        attrString.push(Utils._.template('<%= attrName %> <%= definition %>')({
          attrName: this.quoteIdentifier(attributeName),
          definition: definition
        }));
      }
    }

    var finalQuery = '';
    if (attrString.length) {
      finalQuery += 'ALTER COLUMN ' + attrString.join(', ');
      finalQuery += constraintString.length ? ' ' : '';
    }
    if (constraintString.length) {
      finalQuery += 'ADD CONSTRAINT ' + constraintString.join(', ');
    }

    return Utils._.template(query)({
      tableName: this.quoteTable(tableName),
      query: finalQuery
    });
  },

  renameColumnQuery: function(tableName, attrBefore, attributes) {
    var query = "EXEC sp_rename '<%= tableName %>.<%= before %>', '<%= after %>', 'COLUMN';"
      , newName = Object.keys(attributes)[0];

    return Utils._.template(query)({
      tableName: this.quoteTable(tableName),
      before: attrBefore,
      after: newName
    });
  },

  bulkInsertQuery: function(tableName, attrValueHashes, options, attributes) {
    options = options || {};
    attributes = attributes || {};
    var query = 'INSERT INTO <%= table %> (<%= attributes %>)<%= output %> VALUES <%= tuples %>;'
      , emptyQuery = 'INSERT INTO <%= table %><%= output %> DEFAULT VALUES'
      , tuples = []
      , allAttributes = []
      , needIdentityInsertWrapper = false
      , allQueries = []
      , outputFragment;

    if (options.returning) {
      outputFragment = ' OUTPUT INSERTED.*';
    }

    Utils._.forEach(attrValueHashes, function(attrValueHash) {
      // special case for empty objects with primary keys
      var fields = Object.keys(attrValueHash);
      var firstAttr = attributes[fields[0]];
      if (fields.length === 1 && firstAttr && firstAttr.autoIncrement && attrValueHash[fields[0]] === null) {
        allQueries.push(emptyQuery);
        return;
      }

      // normal case
      Utils._.forOwn(attrValueHash, function(value, key) {
        if (value !== null && attributes[key] && attributes[key].autoIncrement) {
          needIdentityInsertWrapper = true;
        }

        if (allAttributes.indexOf(key) === -1) {
          if (value === null && attributes[key].autoIncrement)
            return;

          allAttributes.push(key);
        }
      });
    });

    if (allAttributes.length > 0) {
      Utils._.forEach(attrValueHashes, function(attrValueHash) {
        tuples.push('(' +
          allAttributes.map(function(key) {
            return this.escape(attrValueHash[key]);
          }.bind(this)).join(',') +
        ')');
      }.bind(this));

      allQueries.push(query);
    }

    var replacements = {
      table: this.quoteTable(tableName),
      attributes: allAttributes.map(function(attr) {
                    return this.quoteIdentifier(attr);
                  }.bind(this)).join(','),
      tuples: tuples,
      output: outputFragment
    };

    var generatedQuery = Utils._.template(allQueries.join(';'))(replacements);
    if (needIdentityInsertWrapper) {
      generatedQuery = [
        'SET IDENTITY_INSERT', this.quoteTable(tableName), 'ON;',
        generatedQuery,
        'SET IDENTITY_INSERT', this.quoteTable(tableName), 'OFF;',
      ].join(' ');
    }

    return generatedQuery;
  },

  upsertQuery: function(tableName, insertValues, updateValues, where, rawAttributes, options) {
    var query = 'MERGE INTO <%= tableNameQuoted %> WITH(HOLDLOCK) AS <%= targetTableAlias %> USING (<%= sourceTableQuery %>) AS <%= sourceTableAlias%>(<%=insertKeysQuoted%>) ON <%= joinCondition %>';
    query += ' WHEN MATCHED THEN UPDATE SET <%= updateSnippet %> WHEN NOT MATCHED THEN INSERT <%= insertSnippet %> OUTPUT $action, INSERTED.*;';

    var targetTableAlias = this.quoteTable(tableName + '_target')
      , sourceTableAlias = this.quoteTable(tableName + '_source')
      , primaryKeysAttrs = []
      , identityAttrs = []
      , uniqueAttrs = []
      , tableNameQuoted = this.quoteTable(tableName)
      , joinCondition
      , needIdentityInsertWrapper = false;

    
    //Obtain primaryKeys, uniquekeys and identity attrs from rawAttributes as model is not passed
    for (var key in rawAttributes) {
      if (rawAttributes[key].primaryKey) {
        primaryKeysAttrs.push(rawAttributes[key].field || key);
      }
      if (rawAttributes[key].unique) {
        uniqueAttrs.push(rawAttributes[key].field || key);
      }
      if (rawAttributes[key].autoIncrement) {
        identityAttrs.push(rawAttributes[key].field || key);
      }
    }

    var updateKeys = Object.keys(updateValues)
      , insertKeys = Object.keys(insertValues);
    
    var insertKeysQuoted = Utils._.map(insertKeys, function(key) {
      return this.quoteIdentifier(key);
    }.bind(this)).join(', ');

    var insertValuesEscaped = Utils._.map(insertKeys, function(key) {
      return this.escape(insertValues[key]);
    }.bind(this)).join(', ');
    
    var sourceTableQuery = 'VALUES(' + insertValuesEscaped + ')'; //Virtual Table

    //IDENTITY_INSERT Condition
    identityAttrs.forEach(function(key) {
      if (updateValues[key] && updateValues[key] !== null) {
        needIdentityInsertWrapper = true;
        /*
         * IDENTITY_INSERT Column Cannot be updated, only inserted
         * http://stackoverflow.com/a/30176254/2254360
         */
      }
    });

    //Filter NULL Clauses
    var clauses = where.$or.filter(function(clause) {
      var valid = true;
      /*
       * Exclude NULL Composite PK/UK. Partial Composite clauses should also be excluded as it doesn't guarantee a single row
       */
      for (var key in clause) {
        if (!clause[key]) {
          valid = false;
          break;
        }
      }
      return valid;
    });

    /*
     * Generate ON condition using PK(s).
     * If not, generate using UK(s). Else throw error
     */
    var getJoinSnippet = function(array) {
      return Utils._.map(array, function(key) {
        key = this.quoteIdentifier(key);
        return targetTableAlias + '.' + key + ' = ' + sourceTableAlias + '.' + key;
      }.bind(this));
    };

    if (clauses.length === 0) {
      throw new Error('Primary Key or Unique key should be passed to upsert query');      
    } else {
      // Search for primary key attribute in clauses -- Model can have two separate unique keys
      for (key in clauses) {
        var keys = Object.keys(clauses[key]);
        if (primaryKeysAttrs.indexOf(keys[0]) !== -1) {
          joinCondition = getJoinSnippet.bind(this)(primaryKeysAttrs).join(' AND ');
          break;
        }
      }
      if (!joinCondition) {
        joinCondition = getJoinSnippet.bind(this)(uniqueAttrs).join(' AND ');
      }
    }
    
    // Remove the IDENTITY_INSERT Column from update
    var updateSnippet = updateKeys.filter(function(key) {
      if (identityAttrs.indexOf(key) === -1) {
        return true;
      } else {
        return false;
      }
    });

    updateSnippet = Utils._.map(updateSnippet, function(key) {
      var value = this.escape(updateValues[key]);
      key = this.quoteIdentifier(key);
      return targetTableAlias + '.' + key + ' = ' + value;
    }.bind(this)).join(', ');

    var insertSnippet = '(' + insertKeysQuoted + ') VALUES(' + insertValuesEscaped + ')';
    
    var replacements = {
      tableNameQuoted: tableNameQuoted,
      targetTableAlias: targetTableAlias,
      sourceTableQuery: sourceTableQuery,
      sourceTableAlias: sourceTableAlias,
      insertKeysQuoted: insertKeysQuoted,
      joinCondition: joinCondition,
      updateSnippet: updateSnippet,
      insertSnippet: insertSnippet
    };

    query = Utils._.template(query)(replacements);


    if (needIdentityInsertWrapper) {
      query = [
        'SET IDENTITY_INSERT', this.quoteTable(tableName), 'ON;',
        query,
        'SET IDENTITY_INSERT', this.quoteTable(tableName), 'OFF;',
      ].join(' ');
    }
    return query;
  },

  deleteQuery: function(tableName, where, options) {
    options = options || {};

    var table = this.quoteTable(tableName);
    if (options.truncate === true) {
      // Truncate does not allow LIMIT and WHERE
      return 'TRUNCATE TABLE ' + table;
    }

    where = this.getWhereConditions(where);
    var limit = ''
      , query = 'DELETE<%= limit %> FROM <%= table %><%= where %>; ' +
                'SELECT @@ROWCOUNT AS AFFECTEDROWS;';

    if (Utils._.isUndefined(options.limit)) {
      options.limit = 1;
    }

    if (!!options.limit) {
      limit = ' TOP(' + this.escape(options.limit) + ')';
    }

    var replacements = {
      limit: limit,
      table: table,
      where: where,
    };

    if (replacements.where) {
      replacements.where = ' WHERE ' + replacements.where;
    }

    return Utils._.template(query)(replacements);
  },

  showIndexesQuery: function(tableName) {
    var sql = "EXEC sys.sp_helpindex @objname = N'<%= tableName %>';";
    return Utils._.template(sql)({
      tableName: this.quoteTable(tableName)
    });
  },

  removeIndexQuery: function(tableName, indexNameOrAttributes) {
    var sql = 'DROP INDEX <%= indexName %> ON <%= tableName %>'
      , indexName = indexNameOrAttributes;

    if (typeof indexName !== 'string') {
      indexName = Utils.inflection.underscore(tableName + '_' + indexNameOrAttributes.join('_'));
    }

    var values = {
      tableName: this.quoteIdentifiers(tableName),
      indexName: indexName
    };

    return Utils._.template(sql)(values);
  },

  attributeToSQL: function(attribute) {
    if (!Utils._.isPlainObject(attribute)) {
      attribute = {
        type: attribute
      };
    }

    // handle self referential constraints
    if (attribute.references) {
      attribute = Utils.formatReferences(attribute);

      if (attribute.Model && attribute.Model.tableName === attribute.references.model) {
        this.sequelize.log('MSSQL does not support self referencial constraints, '
          + 'we will remove it but we recommend restructuring your query');
        attribute.onDelete = '';
        attribute.onUpdate = '';
      }
    }

    var template;

    if (attribute.type instanceof DataTypes.ENUM) {
      if (attribute.type.values && !attribute.values) attribute.values = attribute.type.values;

      // enums are a special case
      template = attribute.type.toSql();
      template += ' CHECK (' + attribute.field + ' IN(' + Utils._.map(attribute.values, function(value) {
        return this.escape(value);
      }.bind(this)).join(', ') + '))';
      return template;
    } else {
      template = attribute.type.toString();
    }

    if (attribute.allowNull === false) {
      template += ' NOT NULL';
    } else if (!attribute.primaryKey && !Utils.defaultValueSchemable(attribute.defaultValue)) {
      template += ' NULL';
    }

    if (attribute.autoIncrement) {
      template += ' IDENTITY(1,1)';
    }

    // Blobs/texts cannot have a defaultValue
    if (attribute.type !== 'TEXT' && attribute.type._binary !== true &&
        Utils.defaultValueSchemable(attribute.defaultValue)) {
      template += ' DEFAULT ' + this.escape(attribute.defaultValue);
    }

    if (attribute.unique === true) {
      template += ' UNIQUE';
    }

    if (attribute.primaryKey) {
      template += ' PRIMARY KEY';
    }

    if (attribute.references) {
      template += ' REFERENCES ' + this.quoteTable(attribute.references.model);

      if (attribute.references.key) {
        template += ' (' + this.quoteIdentifier(attribute.references.key) + ')';
      } else {
        template += ' (' + this.quoteIdentifier('id') + ')';
      }

      if (attribute.onDelete) {
        template += ' ON DELETE ' + attribute.onDelete.toUpperCase();
      }

      if (attribute.onUpdate) {
        template += ' ON UPDATE ' + attribute.onUpdate.toUpperCase();
      }
    }

    return template;
  },

  attributesToSQL: function(attributes, options) {
    var result = {}
      , key
      , attribute
      , existingConstraints = [];

    for (key in attributes) {
      attribute = attributes[key];

      if (attribute.references) {
        attribute = Utils.formatReferences(attributes[key]);

        if (existingConstraints.indexOf(attribute.references.model.toString()) !== -1) {
          // no cascading constraints to a table more than once
          attribute.onDelete = '';
          attribute.onUpdate = '';
        } else {
          existingConstraints.push(attribute.references.model.toString());

          // NOTE: this really just disables cascading updates for all
          //       definitions. Can be made more robust to support the
          //       few cases where MSSQL actually supports them
          attribute.onUpdate = '';
        }

      }

      if (key && !attribute.field) attribute.field = key;
      result[attribute.field || key] = this.attributeToSQL(attribute, options);
    }

    return result;
  },

  findAutoIncrementField: function(factory) {
    var fields = [];
    for (var name in factory.attributes) {
      if (factory.attributes.hasOwnProperty(name)) {
        var definition = factory.attributes[name];

        if (definition && definition.autoIncrement) {
          fields.push(name);
        }
      }
    }

    return fields;
  },

  createTrigger: function() {
    throwMethodUndefined('createTrigger');
  },

  dropTrigger: function() {
    throwMethodUndefined('dropTrigger');
  },

  renameTrigger: function() {
    throwMethodUndefined('renameTrigger');
  },

  createFunction: function() {
    throwMethodUndefined('createFunction');
  },

  dropFunction: function() {
    throwMethodUndefined('dropFunction');
  },

  renameFunction: function() {
    throwMethodUndefined('renameFunction');
  },

  quoteIdentifier: function(identifier, force) {
      if (identifier === '*') return identifier;
      return '[' + identifier.replace(/[\[\]']+/g,'') + ']';
  },

  getForeignKeysQuery: function(table) {
    var tableName = table.tableName || table;
    var sql = [
      'SELECT',
        'constraint_name = C.CONSTRAINT_NAME',
      'FROM',
        'INFORMATION_SCHEMA.TABLE_CONSTRAINTS C',
      "WHERE C.CONSTRAINT_TYPE = 'FOREIGN KEY'",
      'AND C.TABLE_NAME =', wrapSingleQuote(tableName)
    ].join(' ');

    if (table.schema) {
      sql += ' AND C.TABLE_SCHEMA =' + wrapSingleQuote(table.schema);
    }

    return sql;
  },

  getForeignKeyQuery: function(table, attributeName) {
    var tableName = table.tableName || table;
    var sql = [
      'SELECT',
        'constraint_name = TC.CONSTRAINT_NAME',
      'FROM',
        'INFORMATION_SCHEMA.TABLE_CONSTRAINTS TC',
        'JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE CCU',
          'ON TC.CONSTRAINT_NAME = CCU.CONSTRAINT_NAME',
      "WHERE TC.CONSTRAINT_TYPE = 'FOREIGN KEY'",
      'AND TC.TABLE_NAME =', wrapSingleQuote(tableName),
      'AND CCU.COLUMN_NAME =', wrapSingleQuote(attributeName),
    ].join(' ');

    if (table.schema) {
      sql += ' AND TC.TABLE_SCHEMA =' + wrapSingleQuote(table.schema);
    }

    return sql;
  },

  dropForeignKeyQuery: function(tableName, foreignKey) {
    return Utils._.template('ALTER TABLE <%= table %> DROP <%= key %>')({
      table: this.quoteTable(tableName),
      key: this.quoteIdentifier(foreignKey)
    });
  },

  getDefaultConstraintQuery: function (tableName, attributeName) {
    var sql = "SELECT name FROM SYS.DEFAULT_CONSTRAINTS " +
      "WHERE PARENT_OBJECT_ID = OBJECT_ID('<%= table %>', 'U') " +
      "AND PARENT_COLUMN_ID = (SELECT column_id FROM sys.columns WHERE NAME = ('<%= column %>') " +
      "AND object_id = OBJECT_ID('<%= table %>', 'U'));";
    return Utils._.template(sql)({
      table: this.quoteTable(tableName),
      column: attributeName
    });
  },

  dropConstraintQuery: function (tableName, constraintName) {
    var sql = 'ALTER TABLE <%= table %> DROP CONSTRAINT <%= constraint %>;';
    return Utils._.template(sql)({
      table: this.quoteTable(tableName),
      constraint: this.quoteIdentifier(constraintName)
    });
  },

  setAutocommitQuery: function(value) {
    return '';
    // return 'SET IMPLICIT_TRANSACTIONS ' + (!!value ? 'OFF' : 'ON') + ';';
  },

  setIsolationLevelQuery: function(value, options) {
    if (options.parent) {
      return;
    }

    return 'SET TRANSACTION ISOLATION LEVEL ' + value + ';';
  },

  generateTransactionId: function () {
    return randomBytes(10).toString('hex');
  },

  startTransactionQuery: function(transaction, options) {
    if (transaction.parent) {
      return 'SAVE TRANSACTION ' + this.quoteIdentifier(transaction.name) + ';';
    }

    return 'BEGIN TRANSACTION;';
  },

  commitTransactionQuery: function(transaction) {
    if (transaction.parent) {
      return;
    }

    return 'COMMIT TRANSACTION;';
  },

  rollbackTransactionQuery: function(transaction, options) {
    if (transaction.parent) {
      return 'ROLLBACK TRANSACTION ' + this.quoteIdentifier(transaction.name) + ';';
    }

    return 'ROLLBACK TRANSACTION;';
  },

  selectFromTableFragment: function(options, model, attributes, tables, mainTableAs, where) {
    var topFragment = '';
    var mainFragment = 'SELECT ' + attributes.join(', ') + ' FROM ' + tables;

    // Handle SQL Server 2008 with TOP instead of LIMIT
    if (semver.valid(this.sequelize.options.databaseVersion) && semver.lt(this.sequelize.options.databaseVersion, '11.0.0')) {
      if (options.limit) {
        topFragment = 'TOP ' + options.limit + ' ';
      }
      if (options.offset) {
        var offset = options.offset || 0
          , isSubQuery = options.hasIncludeWhere || options.hasIncludeRequired || options.hasMultiAssociation
          , orders = { mainQueryOrder: [] };
        if (options.order) {
          orders = this.getQueryOrders(options, model, isSubQuery);
        }

        if(!orders.mainQueryOrder.length) {
          orders.mainQueryOrder.push(this.quoteIdentifier(model.primaryKeyField));
        }

        var tmpTable = (mainTableAs) ? mainTableAs : 'OffsetTable';
        var whereFragment = (where) ? ' WHERE ' + where : '';

        /*
         * For earlier versions of SQL server, we need to nest several queries
         * in order to emulate the OFFSET behavior.
         *
         * 1. The outermost query selects all items from the inner query block.
         *    This is due to a limitation in SQL server with the use of computed
         *    columns (e.g. SELECT ROW_NUMBER()...AS x) in WHERE clauses.
         * 2. The next query handles the LIMIT and OFFSET behavior by getting
         *    the TOP N rows of the query where the row number is > OFFSET
         * 3. The innermost query is the actual set we want information from
         */
        var fragment = 'SELECT TOP 100 PERCENT ' + attributes.join(', ') + ' FROM ' +
                        '(SELECT ' + topFragment + '*' +
                          ' FROM (SELECT ROW_NUMBER() OVER (ORDER BY ' + orders.mainQueryOrder.join(', ') + ') as row_num, * ' +
                            ' FROM ' + tables + ' AS ' + tmpTable + whereFragment + ')' +
                          ' AS ' + tmpTable + ' WHERE row_num > ' + offset + ')' +
                        ' AS ' + tmpTable;
        return fragment;
      } else {
        mainFragment = 'SELECT ' + topFragment + attributes.join(', ') + ' FROM ' + tables;
      }
    }

    if(mainTableAs) {
      mainFragment += ' AS ' + mainTableAs;
    }

    return mainFragment;
  },

  addLimitAndOffset: function(options, model) {
    // Skip handling of limit and offset as postfixes for older SQL Server versions
    if(semver.valid(this.sequelize.options.databaseVersion) && semver.lt(this.sequelize.options.databaseVersion, '11.0.0')) {
      return '';
    }

    var fragment = '';
    var offset = options.offset || 0
      , isSubQuery = options.hasIncludeWhere || options.hasIncludeRequired || options.hasMultiAssociation;

    var orders = {};
    if (options.order) {
      orders = this.getQueryOrders(options, model, isSubQuery);
    }

    if (options.limit || options.offset) {
      if (!options.order || (options.include && !orders.subQueryOrder.length)) {
        fragment += (options.order && !isSubQuery) ? ', ' : ' ORDER BY ';
        fragment += this.quoteIdentifier(model.primaryKeyField);
      }

      if (options.offset || options.limit) {
        fragment += ' OFFSET ' + this.escape(offset) + ' ROWS';
      }

      if (options.limit) {
        fragment += ' FETCH NEXT ' + this.escape(options.limit) + ' ROWS ONLY';
      }
    }

    return fragment;
  },

  booleanValue: function(value) {
    return !!value ? 1 : 0;
  }
};

// private methods
function wrapSingleQuote(identifier){
  return Utils.addTicks(identifier, "'");
}

module.exports = Utils._.extend(Utils._.clone(AbstractQueryGenerator), QueryGenerator);
