/**
 * Extend the basic ActorSheet with some shared behaviors
 */
export default class BlackFlagActor extends Actor {


  /**
     * Is this Actor currently in the active Combat encounter?
     * @type {boolean}
     */
  get inCombat() {
    if ( this.isToken ) return !!game.combat?.combatants.find(c => c.tokenId === this.token.id);
    return !!game.combat?.combatants.find(c => c.actorId === this.id);
  }

  /* -------------------------------------------- */

  prepareDerivedData() {
    switch ( this.type ) {
      case "pc": return this._preparePcDerivedData();
    }
  }


  /* -------------------------------------------- */

  async loadForeignDocuments() {

    async function getForeignDocuments(type, subtype) {
      let docs = game.collections.get(type).filter(d => d.type === subtype);

      // / Iterate through the Packs, adding them to the list
      for ( let pack of game.packs ) {
        if ( pack.metadata.type !== type ) continue;
        const ids = pack.index.filter(d => d.type === subtype).map(d => d._id);
        for ( const id of ids ) {
          const doc = await pack.getDocument(id);
          if ( doc ) docs.push(doc);
        }
      }

      // Dedupe and sort the list alphabetically
      docs = Array.from(new Set(docs)).sort((a, b) => a.name.localeCompare(b.name));
      const collection = new Collection();
      for ( let d of docs ) {
        collection.set(d.id, d);
      }
      return collection;
    }

    CONFIG.SYSTEM.LINEAGE_DOCUMENTS = await getForeignDocuments("Item", "lineage");
    CONFIG.SYSTEM.HERITAGE_DOCUMENTS = await getForeignDocuments("Item", "heritage");
    CONFIG.SYSTEM.BACKGROUND_DOCUMENTS = await getForeignDocuments("Item", "background");
    CONFIG.SYSTEM.TALENT_DOCUMENTS = await getForeignDocuments("Item", "talent");
    CONFIG.SYSTEM.CLASS_DOCUMENTS = await getForeignDocuments("Item", "class");
  }

  /* -------------------------------------------- */

  async _preparePcDerivedData() {

    console.log("Black Flag 🏴 | Preparing PC Derived Data");

    this.prepareAbilityScoreMods();
    await this.prepareForeignDocumentData();
    this.prepareCharacterBuilderData();
    this.prepareAdvantages();
  }

  /* -------------------------------------------- */

  prepareAbilityScoreMods() {
    // For each ability score, determine the modifier
    /**
         * 1 = -5
         * 2-3 = -4
         * 4-5 = -3
         * 6-7 = -2
         * 8-9 = -1
         * 10-11 = 0
         * 12-13 = +1
         * 14-15 = +2
         * 16-17 = +3
         * 18-19 = +4
         * 20-21 = +5
         */
    for (let [a, abl] of Object.entries(this.system.abilities)) {
      this.system.abilities[a] = {
        value: abl,
        mod: Math.floor((abl - 10) / 2)
      };
    }
  }

  /* -------------------------------------------- */

  async prepareForeignDocumentData() {
    if (CONFIG.SYSTEM.BACKGROUND_DOCUMENTS.size === 0) {
      await this.loadForeignDocuments();
    }

    this.system.backgroundId = this._source.system.background;
    this.system.background = CONFIG.SYSTEM.BACKGROUND_DOCUMENTS.get(this._source.system.background);
    this.system.heritageId = this._source.system.heritage;
    this.system.heritage = CONFIG.SYSTEM.HERITAGE_DOCUMENTS.get(this._source.system.heritage);
    this.system.lineageId = this._source.system.lineage;
    this.system.lineage = CONFIG.SYSTEM.LINEAGE_DOCUMENTS.get(this._source.system.lineage);
    this.system.classId = this._source.system.class;
    this.system.class = CONFIG.SYSTEM.CLASS_DOCUMENTS.get(this._source.system.class);

    // Load Traits
    this.system.traits = new Set();
    if (this.system.background) {
      for (const trait of this.system.background.system.traits) {
        const data = foundry.utils.duplicate(trait);
        data.source = this.system.background.name;
        data.sourceId = this.system.background._id;
        data.color = this.system.background.system.color;
        this.system.traits.add(data);
      }
    }
    if (this.system.heritage) {
      for (const trait of this.system.heritage.system.traits) {
        const data = foundry.utils.duplicate(trait);
        data.source = this.system.heritage.name;
        data.sourceId = this.system.heritage._id;
        data.color = this.system.heritage.system.color;
        this.system.traits.add(data);
      }
    }
    if (this.system.lineage) {
      for (const trait of this.system.lineage.system.traits) {
        const data = foundry.utils.duplicate(trait);
        data.source = this.system.lineage.name;
        data.sourceId = this.system.lineage._id;
        data.color = this.system.lineage.system.color;
        this.system.traits.add(data);
      }
    }

    // If the actor doesn't have traitChoices for some traits, add them
    for ( const trait of this.system.traits ) {
      if ( !trait.id ) continue;
      if ( !this.system.traitChoices.find(t => t.id === trait.id) ) {
        this.system.traitChoices.add(foundry.utils.mergeObject(foundry.utils.duplicate(trait), {
          choices: [],
          choicesFulfilled: false
        }));
      }
    }

    // Filter out any trait choices that are not in system.traits
    this.system.traitChoices = this.system.traitChoices.filter(t => this.system.traits.find(t2 => t2.id === t.id));
  }

  /* -------------------------------------------- */

  /**
     * Character Builder JSON is of the form:
     * ```json
     * {
     *     "mode": "ALL",  // Default is "ALL"
     *     "options": {
     *       "additionalLanguage": {
     *         "amount": 1,   // Default is 1
     *         "category": "LANGUAGE_TYPES"
     *       }
     *     }
     * }
     * ```
     */
  prepareCharacterBuilderData() {

    // For each trait, parse the character builder data
    for ( const trait of this.system.traitChoices ) {
      if ( foundry.utils.isEmpty(trait.choices) ) trait.choices = [];
      if ( !trait.builderInfo?.options ) {
        trait.choicesFulfilled = true;
        continue;
      }

      const mode = trait.builderInfo.mode || "all";
      trait.builderInfo.mode = mode;
      let choicesMade = 0;

      // Determine what, if any, choices are missing
      for ( const [key, option] of Object.entries(trait.builderInfo.options) ) {
        const amount = option.amount ?? 1;

        // Build the list of choices
        let values = option.values ?? [];

        // If a valuesType is specified and values is empty, add all the values from that category
        if ( option.valuesType && (values.length === 0) ) {
          const category = CONFIG.SYSTEM[option.valuesType];
          if ( !category ) continue;
          values = values.concat(Object.keys(category));
        }

        const currentChoice = trait.choices.find(c => c.key === key);
        if ( currentChoice ) {
          currentChoice.category = option.category;
          currentChoice.label = option.label ?? key;
          currentChoice.category = option.category;
          currentChoice.options = values;
          currentChoice.amount = amount;
          if ( currentChoice.chosenValues.size === amount ) choicesMade++;
        }
        else {
          trait.choices.push({
            key: key,
            label: option.label ?? key,
            category: option.category,
            options: values,
            chosenValues: new Set(),
            amount: amount
          });
        }
      }

      // Determine if all choices have been made
      switch ( mode ) {
        case "ALL": {
          trait.choicesFulfilled = (choicesMade === Object.keys(trait.builderInfo.options).length);
          break;
        }
        case "ANY": {
          trait.choicesFulfilled = (choicesMade > 0);
          break;
        }
        case "CHOOSE_ONE": {
          trait.choicesFulfilled = (choicesMade === 1);
          break;
        }
      }
    }
  }

  /* -------------------------------------------- */

  prepareAdvantages() {

    // Setup current values with a source of "Manual"
    function mapManualData(types, value) {
      let result = {};
      result.source = "Manual";
      result.sourceType = "manual";
      result.value = value;
      result.label = types[value.value].label;
      return result;
    }
    this.system.proficiencies = this.system.proficiencies.map(p => mapManualData(CONFIG.SYSTEM.PROFICIENCY_TYPES, p));
    this.system.resistances = this.system.resistances.map(r => mapManualData(CONFIG.SYSTEM.DAMAGE_TYPES, r));
    this.system.languages = this.system.languages.map(l => mapManualData(CONFIG.SYSTEM.LANGUAGE_TYPES, l));
    this.system.saveAdvantages = this.system.saveAdvantages.map(s => mapManualData(CONFIG.SYSTEM.SAVE_TYPES, s));

    function buildStyleString(trait, result) {
      // Build a Style string
      let style = "";
      if (trait.color) {
        style += `background-color: ${trait.color};`;

        // Calculate the font color based on the background HEX color
        const rgb = trait.color.match(/\w\w/g).map(c => parseInt(c, 16));
        const brightness = Math.round(((rgb[0] * 299) + (rgb[1] * 587) + (rgb[2] * 114)) / 1000);
        style += `color: ${brightness > 125 ? "black" : "white"};`;
      }

      result.style = style;
    }

    // Add innate values
    function mapInnate(trait, types, innate) {
      const config = types[innate];
      if (!config) {
        CONFIG.SYSTEM.log(`Unknown type ${innate} in ${trait.source} (${trait.name})`);
        return;
      }
      let result = {};
      result.source = `${trait.source} (${trait.name})`;
      result.sourceType = "innate";
      result.sourceId = trait.sourceId;
      result.value = innate;
      result.label = config.label;
      buildStyleString(trait, result);
      return result;
    }
    for (const trait of this.system.traits) {
      trait.innate.proficiencies
        .map(p => mapInnate(trait, CONFIG.SYSTEM.PROFICIENCY_TYPES, p))
        .forEach(p => this.system.proficiencies.add(p));

      trait.innate.resistances
        .map(r => mapInnate(trait, CONFIG.SYSTEM.DAMAGE_TYPES, r))
        .forEach(r => this.system.resistances.add(r));

      trait.innate.languages
        .map(l => mapInnate(trait, CONFIG.SYSTEM.LANGUAGE_TYPES, l))
        .forEach(l => this.system.languages.add(l));

      trait.innate.saveAdvantages
        .map(s => mapInnate(trait, CONFIG.SYSTEM.SAVE_TYPES, s))
        .forEach(s => this.system.saveAdvantages.add(s));
    }

    // Add trait choices
    function reduceTraitChoice(trait, category, choice, advantages) {
      if ( choice.category !== category) return advantages;
      for ( const value of choice.chosenValues ) {
        const config = CONFIG.SYSTEM[category][value];
        if (!config) {
          CONFIG.SYSTEM.log(`Unknown type ${value} in ${trait.source} (${trait.name})`);
          continue;
        }
        let result = {};
        result.source = `${trait.source} (${trait.name})`;
        result.sourceId = trait.sourceId;
        result.sourceType = "choice";
        result.value = value;
        result.label = config.label;
        buildStyleString(trait, result);
        advantages.push(result);
      }
      return advantages;
    }
    for (const trait of this.system.traitChoices) {
      trait.choices
        .reduce( (advantages, p) => reduceTraitChoice(trait, "PROFICIENCY_TYPES", p, advantages), [])
        .forEach(p => this.system.proficiencies.add(p));

      trait.choices
        .reduce( (advantages, r) => reduceTraitChoice(trait, "DAMAGE_TYPES", r, advantages), [])
        .forEach(r => this.system.resistances.add(r));

      trait.choices
        .reduce( (advantages, l) => reduceTraitChoice(trait, "LANGUAGE_TYPES", l, advantages), [])
        .forEach(l => this.system.languages.add(l));

      trait.choices
        .reduce( (advantages, s) => reduceTraitChoice(trait, "SAVE_TYPES", s, advantages), [])
        .forEach(s => this.system.saveAdvantages.add(s));
    }

    // Sort the lists alphabetically
    this.system.proficiencies = new Set(
      Array.from(this.system.proficiencies)
        .sort((a, b) => a.label.localeCompare(b.label))
    );
    this.system.resistances = new Set(
      Array.from(this.system.resistances)
        .sort((a, b) => a.label.localeCompare(b.label))
    );
    this.system.languages = new Set(
      Array.from(this.system.languages)
        .sort((a, b) => a.label.localeCompare(b.label))
    );
    this.system.saveAdvantages = new Set(
      Array.from(this.system.saveAdvantages)
        .sort((a, b) => a.label.localeCompare(b.label))
    );

  }
}
