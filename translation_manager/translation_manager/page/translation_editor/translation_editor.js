frappe.pages["translation-editor"].on_page_load = function(wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Translation Editor"),
		single_column: true
	});

	new TranslationEditor(page);
};

class TranslationEditor {
	constructor(page) {
		this.page = page;
		this.entries = [];
		this.modified = {};
		this.reference_languages = [];
		this.reference_translations = {};
		this.plural_forms = null;
		this.num_plurals = 2;

		// Plural form labels for common languages
		this.plural_labels = {
			// Slavic languages (3 forms)
			"uk": ["Однина (1, 21, 31...)", "Декілька (2-4, 22-24...)", "Багато (0, 5-20, 25-30...)"],
			"ru": ["Единственное (1, 21, 31...)", "Несколько (2-4, 22-24...)", "Много (0, 5-20, 25-30...)"],
			"pl": ["Jeden (1)", "Kilka (2-4, 22-24...)", "Wiele (0, 5-21, 25-31...)"],
			// Germanic/Romance (2 forms)
			"en": ["Singular (1)", "Plural (0, 2, 3...)"],
			"de": ["Singular (1)", "Plural (0, 2, 3...)"],
			"fr": ["Singulier (0, 1)", "Pluriel (2, 3...)"],
			"es": ["Singular (1)", "Plural (0, 2, 3...)"],
			// Default
			"default": ["Form 0", "Form 1", "Form 2", "Form 3", "Form 4", "Form 5"]
		};

		this.setup_page();
		this.load_apps();
		this.load_reference_languages();
	}

	setup_page() {
		// App selector
		this.app_field = this.page.add_field({
			label: __("App"),
			fieldtype: "Select",
			fieldname: "app",
			change: () => this.on_app_change()
		});

		// Language selector
		this.language_field = this.page.add_field({
			label: __("Language"),
			fieldtype: "Link",
			fieldname: "language",
			options: "Language",
			change: () => this.load_translations()
		});

		// Search field
		this.search_field = this.page.add_field({
			label: __("Search"),
			fieldtype: "Data",
			fieldname: "search",
			change: () => this.filter_entries()
		});

		// Filter buttons
		this.page.add_inner_button(__("All"), () => {
			this.filter_mode = "all";
			this.filter_entries();
		}, __("Filter"));

		this.page.add_inner_button(__("Untranslated"), () => {
			this.filter_mode = "untranslated";
			this.filter_entries();
		}, __("Filter"));

		this.page.add_inner_button(__("Fuzzy"), () => {
			this.filter_mode = "fuzzy";
			this.filter_entries();
		}, __("Filter"));

		// Action buttons
		this.page.set_primary_action(__("Save All"), () => this.save_all());

		this.page.add_action_item(__("Generate POT"), () => this.generate_pot());
		this.page.add_action_item(__("Create Language"), () => this.create_language());
		this.page.add_action_item(__("Export PO"), () => this.export_po());
		this.page.add_action_item(__("Import PO"), () => this.import_po());
		this.page.add_action_item(__("Copy to App"), () => this.copy_to_app());
		this.page.add_action_item(__("Backups"), () => this.show_backups());
		this.page.add_action_item(__("Reference Languages"), () => this.configure_reference_languages());

		// Main container
		this.container = $(`
			<div class="translation-editor-container">
				<div class="translation-stats mb-4"></div>
				<div class="translation-list"></div>
				<div class="translation-pagination mt-4"></div>
			</div>
		`).appendTo(this.page.main);

		// Pagination
		this.page_size = 50;
		this.current_page = 0;
		this.filter_mode = "all";
	}

	load_apps() {
		frappe.call({
			method: "translation_manager.api.get_installed_apps",
			callback: (r) => {
				if (r.message) {
					const options = r.message.map(app =>
						`${app.app_name}|${app.app_title}`
					);
					this.app_field.df.options = options.join("\n");
					this.app_field.refresh();

					// Set first app
					if (options.length) {
						this.app_field.set_value(options[0]);
					}
				}
			}
		});
	}

	on_app_change() {
		const app = this.get_app();
		if (app) {
			this.load_translations();
		}
	}

	get_app() {
		const value = this.app_field.get_value();
		if (value) {
			return value.split("|")[0];
		}
		return null;
	}

	load_translations() {
		const app = this.get_app();
		const language = this.language_field.get_value();

		if (!app || !language) {
			this.container.find(".translation-list").html(
				`<div class="text-muted text-center p-5">${__("Select an app and language to start translating")}</div>`
			);
			return;
		}

		this.current_language = language;

		frappe.call({
			method: "translation_manager.api.get_po_entries",
			args: { app: app, language: language },
			freeze: true,
			freeze_message: __("Loading translations..."),
			callback: (r) => {
				if (r.message) {
					// New response format with plural info
					this.entries = r.message.entries || r.message;
					this.plural_forms = r.message.plural_forms || null;
					this.num_plurals = r.message.num_plurals || 2;
					this.modified = {};
					this.current_page = 0;
					this.update_stats();
					this.filter_entries();
				}
			}
		});
	}

	update_stats() {
		const total = this.entries.length;
		// For plural entries, check if all forms are translated
		const translated = this.entries.filter(e => {
			if (e.is_plural && Array.isArray(e.msgstr)) {
				return e.msgstr.every(s => s && s.trim());
			}
			return e.msgstr && (typeof e.msgstr === 'string' ? e.msgstr.trim() : true);
		}).length;
		const fuzzy = this.entries.filter(e => e.fuzzy).length;
		const plurals = this.entries.filter(e => e.is_plural).length;
		const progress = total ? Math.round(translated / total * 100) : 0;

		// Plural forms info
		let pluralInfo = "";
		if (this.plural_forms) {
			pluralInfo = `
				<div class="plural-forms-info mt-3 p-2 bg-light rounded">
					<small class="text-muted">
						<strong>${__("Plural Forms")}:</strong> ${this.num_plurals} ${__("forms")}
						${plurals > 0 ? `| <strong>${plurals}</strong> ${__("plural entries")}` : ""}
					</small>
				</div>
			`;
		}

		this.container.find(".translation-stats").html(`
			<div class="row">
				<div class="col-md-3">
					<div class="stat-box">
						<div class="stat-value">${total}</div>
						<div class="stat-label">${__("Total Strings")}</div>
					</div>
				</div>
				<div class="col-md-3">
					<div class="stat-box">
						<div class="stat-value text-success">${translated}</div>
						<div class="stat-label">${__("Translated")}</div>
					</div>
				</div>
				<div class="col-md-3">
					<div class="stat-box">
						<div class="stat-value text-danger">${total - translated}</div>
						<div class="stat-label">${__("Untranslated")}</div>
					</div>
				</div>
				<div class="col-md-3">
					<div class="stat-box">
						<div class="stat-value text-warning">${fuzzy}</div>
						<div class="stat-label">${__("Fuzzy")}</div>
					</div>
				</div>
			</div>
			<div class="progress mt-3" style="height: 10px;">
				<div class="progress-bar bg-success" style="width: ${progress}%"></div>
			</div>
			${pluralInfo}
		`);
	}

	// Helper to get msgstr as string for search (handles both singular and plural)
	get_msgstr_string(entry) {
		if (entry.is_plural && Array.isArray(entry.msgstr)) {
			return entry.msgstr.join(" ");
		}
		return entry.msgstr || "";
	}

	filter_entries() {
		let filtered = [...this.entries];
		const search = (this.search_field.get_value() || "").toLowerCase().trim();

		// Apply search filter
		if (search) {
			filtered = filtered.filter(e => {
				const msgid_lower = e.msgid.toLowerCase();
				const msgid_plural_lower = (e.msgid_plural || "").toLowerCase();
				const msgstr_lower = this.get_msgstr_string(e).toLowerCase();
				return msgid_lower.includes(search) || msgid_plural_lower.includes(search) || msgstr_lower.includes(search);
			});

			// Sort by relevance: exact matches first, then starts with, then contains
			filtered.sort((a, b) => {
				const a_msgid = a.msgid.toLowerCase();
				const b_msgid = b.msgid.toLowerCase();
				const a_msgstr = this.get_msgstr_string(a).toLowerCase();
				const b_msgstr = this.get_msgstr_string(b).toLowerCase();

				// Score calculation:
				// 4 = exact match
				// 3 = starts with search
				// 2 = word boundary match
				// 1 = contains search
				const getScore = (msgid, msgstr) => {
					if (msgid === search || msgstr === search) return 4;
					if (msgid.startsWith(search) || msgstr.startsWith(search)) return 3;
					// Word boundary - search term at start of word
					if (new RegExp(`\\b${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(msgid) ||
					    new RegExp(`\\b${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(msgstr)) return 2;
					return 1;
				};

				const scoreA = getScore(a_msgid, a_msgstr);
				const scoreB = getScore(b_msgid, b_msgstr);

				if (scoreA !== scoreB) {
					return scoreB - scoreA; // Higher score first
				}

				// If same score, sort alphabetically
				return a_msgid.localeCompare(b_msgid);
			});
		}

		// Apply mode filter
		if (this.filter_mode === "untranslated") {
			filtered = filtered.filter(e => !this.is_entry_translated(e));
		} else if (this.filter_mode === "fuzzy") {
			filtered = filtered.filter(e => e.fuzzy);
		}

		this.filtered_entries = filtered;
		this.current_page = 0;
		this.render_entries();
	}

	get_plural_label(index) {
		const lang = this.current_language || "default";
		const labels = this.plural_labels[lang] || this.plural_labels["default"];
		return labels[index] || `Form ${index}`;
	}

	is_entry_translated(entry) {
		if (entry.is_plural && Array.isArray(entry.msgstr)) {
			return entry.msgstr.every(s => s && s.trim());
		}
		return entry.msgstr && (typeof entry.msgstr === 'string' ? entry.msgstr.trim() : true);
	}

	render_entries() {
		const start = this.current_page * this.page_size;
		const end = start + this.page_size;
		const page_entries = this.filtered_entries.slice(start, end);

		if (!page_entries.length) {
			this.container.find(".translation-list").html(
				`<div class="text-muted text-center p-5">${__("No entries found")}</div>`
			);
			this.container.find(".translation-pagination").empty();
			return;
		}

		let html = '<div class="translation-entries">';
		for (const entry of page_entries) {
			const modified_class = this.modified[entry.msgid] ? "modified" : "";
			const is_translated = this.is_entry_translated(entry);
			const status_class = !is_translated ? "untranslated" : (entry.fuzzy ? "fuzzy" : "translated");

			// Build locations display
			let locations_html = "";
			if (entry.locations && entry.locations.length > 0) {
				const locations_text = entry.locations.slice(0, 3).join(", ");
				const more_count = entry.locations.length > 3 ? ` (+${entry.locations.length - 3} more)` : "";
				locations_html = `<div class="entry-locations text-muted small mt-1">
					<i class="fa fa-map-marker"></i> ${frappe.utils.escape_html(locations_text)}${more_count}
				</div>`;
			}

			// Build context display
			let context_html = "";
			if (entry.context) {
				context_html = `<div class="entry-context text-muted small mt-1">
					<i class="fa fa-info-circle"></i> Context: ${frappe.utils.escape_html(entry.context)}
				</div>`;
			}

			// Build comments display
			let comments_html = "";
			if (entry.auto_comments) {
				comments_html = `<div class="entry-comments text-muted small mt-1">
					<i class="fa fa-comment"></i> ${frappe.utils.escape_html(entry.auto_comments.split('\n')[0])}
				</div>`;
			}

			// Build translation inputs - different for plural vs singular
			let translation_inputs_html = "";
			if (entry.is_plural) {
				// Plural entry - show multiple inputs
				const msgstr_array = Array.isArray(entry.msgstr) ? entry.msgstr : [];
				translation_inputs_html = `
					<div class="plural-badge mb-2">
						<span class="badge badge-info">${__("Plural")}</span>
					</div>
					<div class="plural-source mb-2">
						<div class="small text-muted">${__("Singular")}:</div>
						<div class="entry-source-quote">
							<div class="entry-text">${frappe.utils.escape_html(entry.msgid)}</div>
						</div>
						<div class="small text-muted mt-1">${__("Plural")}:</div>
						<div class="entry-source-quote">
							<div class="entry-text">${frappe.utils.escape_html(entry.msgid_plural || "")}</div>
						</div>
					</div>
					<div class="plural-forms">
				`;
				for (let i = 0; i < this.num_plurals; i++) {
					const value = msgstr_array[i] || "";
					translation_inputs_html += `
						<div class="plural-form-group mb-2">
							<label class="small text-muted">${this.get_plural_label(i)}</label>
							<textarea class="form-control translation-input plural-input"
								rows="1"
								data-plural-index="${i}">${frappe.utils.escape_html(value)}</textarea>
						</div>
					`;
				}
				translation_inputs_html += `</div>`;
			} else {
				// Regular singular entry
				translation_inputs_html = `
					<textarea class="form-control translation-input" rows="2">${frappe.utils.escape_html(entry.msgstr || "")}</textarea>
				`;
			}

			// For plural entries, we need different source display
			let source_html = "";
			if (entry.is_plural) {
				source_html = `
					<div class="entry-source">
						<div class="entry-label">${__("Source")} <span class="badge badge-info">${__("Plural")}</span></div>
						<div class="plural-source-display">
							<div class="mb-1">
								<small class="text-muted">${__("Singular")}:</small>
								<div class="entry-source-quote">
									<div class="entry-text">${frappe.utils.escape_html(entry.msgid)}</div>
									<button class="btn btn-xs btn-default copy-source-btn" data-text="${frappe.utils.escape_html(entry.msgid)}" title="${__("Copy to clipboard")}">
										<svg class="icon icon-sm"><use href="#icon-copy"></use></svg>
									</button>
								</div>
							</div>
							<div>
								<small class="text-muted">${__("Plural")}:</small>
								<div class="entry-source-quote">
									<div class="entry-text">${frappe.utils.escape_html(entry.msgid_plural || "")}</div>
									<button class="btn btn-xs btn-default copy-source-btn" data-text="${frappe.utils.escape_html(entry.msgid_plural || "")}" title="${__("Copy to clipboard")}">
										<svg class="icon icon-sm"><use href="#icon-copy"></use></svg>
									</button>
								</div>
							</div>
						</div>
						${locations_html}
						${context_html}
						${comments_html}
					</div>
				`;
			} else {
				source_html = `
					<div class="entry-source">
						<div class="entry-label">${__("Source")}</div>
						<div class="entry-source-quote">
							<div class="entry-text">${frappe.utils.escape_html(entry.msgid)}</div>
							<button class="btn btn-xs btn-default copy-source-btn" data-text="${frappe.utils.escape_html(entry.msgid)}" title="${__("Copy to clipboard")}">
								<svg class="icon icon-sm"><use href="#icon-copy"></use></svg>
							</button>
						</div>
						${locations_html}
						${context_html}
						${comments_html}
						<button class="btn btn-xs btn-info convert-to-plural-btn mt-2"
							data-msgid="${frappe.utils.escape_html(entry.msgid)}"
							data-msgstr="${frappe.utils.escape_html(entry.msgstr || "")}">
							<i class="fa fa-language"></i> ${__("Convert to Plural")}
						</button>
					</div>
				`;
			}

			html += `
				<div class="translation-entry ${modified_class} ${status_class}"
					data-msgid="${frappe.utils.escape_html(entry.msgid)}"
					data-msgid-plural="${frappe.utils.escape_html(entry.msgid_plural || "")}"
					data-is-plural="${entry.is_plural ? "1" : "0"}">
					${source_html}
					<div class="entry-translation">
						<div class="entry-label">${__("Translation")}</div>
						${entry.is_plural ? this.render_plural_inputs(entry) : `<textarea class="form-control translation-input" rows="2">${frappe.utils.escape_html(entry.msgstr || "")}</textarea>`}
						<label class="fuzzy-checkbox mt-2">
							<input type="checkbox" class="fuzzy-input" ${entry.fuzzy ? "checked" : ""}>
							${__("Fuzzy (needs review)")}
						</label>
					</div>
				</div>
			`;
		}
		html += "</div>";

		this.container.find(".translation-list").html(html);

		// Bind events for singular entries
		this.container.find(".translation-entry[data-is-plural='0'] .translation-input").on("input", (e) => {
			const $entry = $(e.target).closest(".translation-entry");
			const msgid = $entry.data("msgid");
			const msgstr = e.target.value;
			const fuzzy = $entry.find(".fuzzy-input").prop("checked");

			this.modified[msgid] = { msgstr, fuzzy, is_plural: false };
			$entry.addClass("modified");
		});

		// Bind events for plural entries
		this.container.find(".translation-entry[data-is-plural='1'] .plural-input").on("input", (e) => {
			const $entry = $(e.target).closest(".translation-entry");
			const msgid = $entry.data("msgid");
			const msgid_plural = $entry.data("msgid-plural");
			const fuzzy = $entry.find(".fuzzy-input").prop("checked");

			// Collect all plural form values
			const msgstr = [];
			$entry.find(".plural-input").each((_i, el) => {
				msgstr.push($(el).val());
			});

			this.modified[msgid] = { msgstr, fuzzy, is_plural: true, msgid_plural };
			$entry.addClass("modified");
		});

		this.container.find(".fuzzy-input").on("change", (e) => {
			const $entry = $(e.target).closest(".translation-entry");
			const msgid = $entry.data("msgid");
			const is_plural = $entry.data("is-plural") === "1";
			const fuzzy = e.target.checked;

			if (is_plural) {
				const msgid_plural = $entry.data("msgid-plural");
				const msgstr = [];
				$entry.find(".plural-input").each((_i, el) => {
					msgstr.push($(el).val());
				});
				this.modified[msgid] = { msgstr, fuzzy, is_plural: true, msgid_plural };
			} else {
				const msgstr = $entry.find(".translation-input").val();
				this.modified[msgid] = { msgstr, fuzzy, is_plural: false };
			}
			$entry.addClass("modified");
		});

		// Bind copy source button
		this.container.find(".copy-source-btn").on("click", (e) => {
			e.preventDefault();
			const text = $(e.currentTarget).data("text");

			// Copy to clipboard
			navigator.clipboard.writeText(text).then(() => {
				frappe.show_alert({
					message: __("Copied to clipboard"),
					indicator: "green"
				});
			}).catch(() => {
				// Fallback for older browsers
				const textarea = document.createElement('textarea');
				textarea.value = text;
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand('copy');
				document.body.removeChild(textarea);
				frappe.show_alert({
					message: __("Copied to clipboard"),
					indicator: "green"
				});
			});
		});

		// Bind convert to plural button
		this.container.find(".convert-to-plural-btn").on("click", (e) => {
			e.preventDefault();
			const msgid = $(e.currentTarget).data("msgid");
			const msgstr = $(e.currentTarget).data("msgstr");
			this.show_convert_to_plural_dialog(msgid, msgstr);
		});

		// Render pagination
		this.render_pagination();

		// Load reference translations for current page
		this.load_reference_translations();
	}

	show_convert_to_plural_dialog(msgid, existing_translation) {
		const app = this.get_app();
		const language = this.language_field.get_value();

		// Try to guess singular/plural forms from msgid
		// Common patterns: "{0} rows", "{0} items", etc.
		let suggested_singular = msgid.replace(/\{0\}\s*(\w+)s\b/i, "{0} $1");
		let suggested_plural = msgid;

		// If no change was made, try other patterns
		if (suggested_singular === msgid) {
			suggested_singular = msgid.replace(/(\d+)\s*(\w+)s\b/i, "1 $2");
			if (suggested_singular === msgid) {
				suggested_singular = msgid;
			}
		}

		// Build plural form fields dynamically
		const plural_fields = [];
		for (let i = 0; i < this.num_plurals; i++) {
			plural_fields.push({
				label: this.get_plural_label(i),
				fieldname: `msgstr_${i}`,
				fieldtype: "Data",
				default: i === this.num_plurals - 1 ? existing_translation : "",
				reqd: 1
			});
		}

		const dialog = new frappe.ui.Dialog({
			title: __("Convert to Plural Form"),
			fields: [
				{
					fieldtype: "HTML",
					options: `<div class="alert alert-info">
						<strong>${__("Original")}:</strong> ${frappe.utils.escape_html(msgid)}<br>
						<small class="text-muted">${__("This will replace the singular entry with a plural form that supports {0} forms for this language.", [this.num_plurals])}</small>
					</div>`
				},
				{
					fieldtype: "Section Break",
					label: __("Source (English)")
				},
				{
					label: __("Singular Form") + " (e.g., '1 row', '{0} row')",
					fieldname: "msgid_singular",
					fieldtype: "Data",
					default: suggested_singular,
					reqd: 1,
					description: __("The form used when count = 1")
				},
				{
					label: __("Plural Form") + " (e.g., '{0} rows')",
					fieldname: "msgid_plural",
					fieldtype: "Data",
					default: suggested_plural,
					reqd: 1,
					description: __("The form used for other counts")
				},
				{
					fieldtype: "Section Break",
					label: __("Translations")
				},
				...plural_fields
			],
			size: "large",
			primary_action_label: __("Convert"),
			primary_action: (values) => {
				// Collect msgstr forms
				const msgstr_forms = [];
				for (let i = 0; i < this.num_plurals; i++) {
					msgstr_forms.push(values[`msgstr_${i}`] || "");
				}

				frappe.call({
					method: "translation_manager.api.convert_to_plural",
					args: {
						app,
						language,
						msgid,
						msgid_singular: values.msgid_singular,
						msgid_plural: values.msgid_plural,
						msgstr_forms
					},
					freeze: true,
					freeze_message: __("Converting to plural..."),
					callback: (r) => {
						if (r.message && r.message.success) {
							frappe.show_alert({
								message: __("Converted to plural form successfully"),
								indicator: "green"
							});
							dialog.hide();
							// Reload translations to see the change
							this.load_translations();
						}
					}
				});
			}
		});

		dialog.show();
	}

	render_plural_inputs(entry) {
		const msgstr_array = Array.isArray(entry.msgstr) ? entry.msgstr : [];
		let html = '<div class="plural-forms">';
		for (let i = 0; i < this.num_plurals; i++) {
			const value = msgstr_array[i] || "";
			html += `
				<div class="plural-form-group mb-2">
					<label class="small text-muted">${this.get_plural_label(i)}</label>
					<textarea class="form-control plural-input"
						rows="1"
						data-plural-index="${i}">${frappe.utils.escape_html(value)}</textarea>
				</div>
			`;
		}
		html += '</div>';
		return html;
	}

	render_pagination() {
		const total_pages = Math.ceil(this.filtered_entries.length / this.page_size);

		if (total_pages <= 1) {
			this.container.find(".translation-pagination").empty();
			return;
		}

		let html = '<nav><ul class="pagination justify-content-center">';

		// Previous button
		html += `<li class="page-item ${this.current_page === 0 ? "disabled" : ""}">
			<a class="page-link" href="#" data-page="${this.current_page - 1}">&laquo;</a>
		</li>`;

		// Page numbers
		for (let i = 0; i < total_pages; i++) {
			if (i === 0 || i === total_pages - 1 || Math.abs(i - this.current_page) <= 2) {
				html += `<li class="page-item ${i === this.current_page ? "active" : ""}">
					<a class="page-link" href="#" data-page="${i}">${i + 1}</a>
				</li>`;
			} else if (Math.abs(i - this.current_page) === 3) {
				html += '<li class="page-item disabled"><span class="page-link">...</span></li>';
			}
		}

		// Next button
		html += `<li class="page-item ${this.current_page === total_pages - 1 ? "disabled" : ""}">
			<a class="page-link" href="#" data-page="${this.current_page + 1}">&raquo;</a>
		</li>`;

		html += "</ul></nav>";

		this.container.find(".translation-pagination").html(html);

		// Bind pagination events
		this.container.find(".page-link").on("click", (e) => {
			e.preventDefault();
			const page = parseInt($(e.target).data("page"));
			if (page >= 0 && page < total_pages) {
				this.current_page = page;
				this.render_entries();
			}
		});
	}

	save_all() {
		const app = this.get_app();
		const language = this.language_field.get_value();

		if (!app || !language) {
			frappe.msgprint(__("Please select an app and language"));
			return;
		}

		const translations = Object.entries(this.modified).map(([msgid, data]) => ({
			msgid,
			msgstr: data.msgstr,
			fuzzy: data.fuzzy,
			is_plural: data.is_plural || false,
			msgid_plural: data.msgid_plural || null
		}));

		if (!translations.length) {
			frappe.msgprint(__("No changes to save"));
			return;
		}

		frappe.call({
			method: "translation_manager.api.save_translations_batch",
			args: {
				app,
				language,
				translations
			},
			freeze: true,
			freeze_message: __("Saving translations..."),
			callback: (r) => {
				if (r.message && r.message.success) {
					// Update local entries
					for (const t of translations) {
						const entry = this.entries.find(e => e.msgid === t.msgid);
						if (entry) {
							entry.msgstr = t.msgstr;
							entry.fuzzy = t.fuzzy;
							entry.translated = t.msgstr ? 1 : 0;
						}
					}

					this.modified = {};
					this.update_stats();
					this.render_entries();

					// Ask to compile MO file
					frappe.confirm(
						__("{0} translations saved. Compile MO file to apply changes on the site?", [r.message.saved]),
						() => this.compile_mo(),
						() => frappe.show_alert({
							message: __("Don't forget to compile MO file later!"),
							indicator: "yellow"
						})
					);
				}
			}
		});
	}

	compile_mo() {
		const app = this.get_app();
		const language = this.language_field.get_value();

		if (!app || !language) return;

		frappe.call({
			method: "translation_manager.api.compile_mo",
			args: { app, language },
			freeze: true,
			freeze_message: __("Compiling MO file..."),
			callback: (r) => {
				if (r.message && r.message.success) {
					frappe.show_alert({
						message: __("MO file compiled. Refresh the page to see changes."),
						indicator: "green"
					});
				}
			}
		});
	}

	generate_pot() {
		const app = this.get_app();
		if (!app) {
			frappe.msgprint(__("Please select an app"));
			return;
		}

		frappe.call({
			method: "translation_manager.api.generate_pot",
			args: { app },
			freeze: true,
			freeze_message: __("Generating POT file..."),
			callback: (r) => {
				if (r.message && r.message.success) {
					frappe.show_alert({
						message: __("POT file generated successfully"),
						indicator: "green"
					});
					this.load_translations();
				}
			}
		});
	}

	create_language() {
		const app = this.get_app();
		if (!app) {
			frappe.msgprint(__("Please select an app"));
			return;
		}

		const dialog = new frappe.ui.Dialog({
			title: __("Create New Language File"),
			fields: [
				{
					label: __("Language"),
					fieldname: "language",
					fieldtype: "Link",
					options: "Language",
					reqd: 1
				}
			],
			primary_action_label: __("Create"),
			primary_action: (values) => {
				frappe.call({
					method: "translation_manager.api.create_po_file",
					args: {
						app,
						language: values.language
					},
					freeze: true,
					callback: (r) => {
						if (r.message && r.message.success) {
							frappe.show_alert({
								message: __("Language file created successfully"),
								indicator: "green"
							});
							dialog.hide();
							this.language_field.set_value(values.language);
						}
					}
				});
			}
		});
		dialog.show();
	}

	export_po() {
		const app = this.get_app();
		const language = this.language_field.get_value();

		if (!app || !language) {
			frappe.msgprint(__("Please select an app and language"));
			return;
		}

		frappe.call({
			method: "translation_manager.api.export_po",
			args: { app, language },
			callback: (r) => {
				if (r.message) {
					const blob = new Blob([r.message.content], { type: "text/plain" });
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url;
					a.download = r.message.filename;
					a.click();
					URL.revokeObjectURL(url);
				}
			}
		});
	}

	import_po() {
		const app = this.get_app();
		const language = this.language_field.get_value();

		if (!app || !language) {
			frappe.msgprint(__("Please select an app and language"));
			return;
		}

		new frappe.ui.FileUploader({
			as_dataurl: true,
			allow_multiple: false,
			on_success: (file) => {
				const content = atob(file.dataurl.split(",")[1]);
				frappe.call({
					method: "translation_manager.api.import_po",
					args: { app, language, content },
					freeze: true,
					freeze_message: __("Importing PO file..."),
					callback: (r) => {
						if (r.message && r.message.success) {
							frappe.show_alert({
								message: __("PO file imported successfully"),
								indicator: "green"
							});
							this.load_translations();
						}
					}
				});
			}
		});
	}

	load_reference_languages() {
		frappe.call({
			method: "translation_manager.api.get_reference_languages_settings",
			callback: (r) => {
				this.reference_languages = r.message || [];
			}
		});
	}

	copy_to_app() {
		const source_app = this.get_app();
		const language = this.language_field.get_value();

		if (!source_app || !language) {
			frappe.msgprint(__("Please select an app and language first"));
			return;
		}

		// Get list of apps for target selection
		frappe.call({
			method: "translation_manager.api.get_installed_apps",
			callback: (r) => {
				if (!r.message) return;

				const apps = r.message
					.filter(app => app.app_name !== source_app)
					.map(app => ({ label: app.app_title, value: app.app_name }));

				const dialog = new frappe.ui.Dialog({
					title: __("Copy PO File to Another App"),
					fields: [
						{
							label: __("Source"),
							fieldtype: "Data",
							fieldname: "source",
							default: `${source_app} (${language})`,
							read_only: 1
						},
						{
							label: __("Target App"),
							fieldname: "target_app",
							fieldtype: "Select",
							options: apps.map(a => a.value).join("\n"),
							reqd: 1
						},
						{
							fieldtype: "HTML",
							options: `<p class="text-warning small">${__("This will create a backup of the target app's translations before copying.")}</p>`
						}
					],
					primary_action_label: __("Copy"),
					primary_action: (values) => {
						frappe.call({
							method: "translation_manager.api.copy_po_to_app",
							args: {
								source_app,
								target_app: values.target_app,
								language
							},
							freeze: true,
							freeze_message: __("Copying translations..."),
							callback: (r) => {
								if (r.message && r.message.success) {
									frappe.show_alert({
										message: __("Translations copied successfully"),
										indicator: "green"
									});
									dialog.hide();
								}
							}
						});
					}
				});
				dialog.show();
			}
		});
	}

	show_backups() {
		const app = this.get_app();
		const language = this.language_field.get_value();

		if (!app || !language) {
			frappe.msgprint(__("Please select an app and language first"));
			return;
		}

		frappe.call({
			method: "translation_manager.api.get_backups",
			args: { app, language },
			callback: (r) => {
				const backups = r.message || [];

				if (!backups.length) {
					frappe.msgprint(__("No backups found for {0} ({1})", [app, language]));
					return;
				}

				const dialog = new frappe.ui.Dialog({
					title: __("Translation Backups"),
					fields: [
						{
							label: __("Available Backups"),
							fieldname: "backup",
							fieldtype: "Select",
							options: backups.map(b => ({
								label: `${b.filename} (${frappe.datetime.prettyDate(new Date(b.modified * 1000))})`,
								value: b.filename
							})).map(o => o.value).join("\n"),
							reqd: 1
						},
						{
							fieldtype: "HTML",
							options: `<p class="text-warning small">${__("Restoring a backup will create a backup of the current file first.")}</p>`
						}
					],
					primary_action_label: __("Restore"),
					primary_action: (values) => {
						frappe.confirm(
							__("Are you sure you want to restore this backup? Current translations will be backed up first."),
							() => {
								frappe.call({
									method: "translation_manager.api.restore_backup",
									args: {
										app,
										language,
										backup_filename: values.backup
									},
									freeze: true,
									freeze_message: __("Restoring backup..."),
									callback: (r) => {
										if (r.message && r.message.success) {
											frappe.show_alert({
												message: __("Backup restored successfully"),
												indicator: "green"
											});
											dialog.hide();
											this.load_translations();
										}
									}
								});
							}
						);
					}
				});
				dialog.show();
			}
		});
	}

	configure_reference_languages() {
		const dialog = new frappe.ui.Dialog({
			title: __("Configure Reference Languages"),
			fields: [
				{
					label: __("Reference Languages"),
					fieldname: "languages",
					fieldtype: "Table",
					cannot_add_rows: false,
					in_place_edit: true,
					data: this.reference_languages.map(lang => ({ language: lang })),
					fields: [
						{
							label: __("Language"),
							fieldname: "language",
							fieldtype: "Link",
							options: "Language",
							in_list_view: 1,
							reqd: 1
						}
					]
				},
				{
					fieldtype: "HTML",
					options: `<p class="text-muted small">${__("These languages will be shown as translation hints when editing. Useful for related languages like Russian, Polish, etc.")}</p>`
				}
			],
			primary_action_label: __("Save"),
			primary_action: (values) => {
				const languages = (values.languages || [])
					.filter(row => row.language)
					.map(row => row.language);

				frappe.call({
					method: "translation_manager.api.save_reference_languages_settings",
					args: { languages },
					callback: (r) => {
						if (r.message && r.message.success) {
							this.reference_languages = languages;
							frappe.show_alert({
								message: __("Reference languages saved"),
								indicator: "green"
							});
							dialog.hide();
							// Reload reference translations if we have entries loaded
							if (this.filtered_entries && this.filtered_entries.length) {
								this.load_reference_translations();
							}
						}
					}
				});
			}
		});
		dialog.show();
	}

	load_reference_translations() {
		const app = this.get_app();
		if (!app || !this.reference_languages.length || !this.filtered_entries) {
			this.reference_translations = {};
			return;
		}

		// Get msgids for current page
		const start = this.current_page * this.page_size;
		const end = start + this.page_size;
		const page_entries = this.filtered_entries.slice(start, end);
		const msgids = page_entries.map(e => e.msgid);

		frappe.call({
			method: "translation_manager.api.get_reference_translations",
			args: {
				app,
				msgids,
				reference_languages: this.reference_languages
			},
			callback: (r) => {
				this.reference_translations = r.message || {};
				this.update_reference_hints();
			}
		});
	}

	update_reference_hints() {
		this.container.find(".translation-entry").each((_i, el) => {
			const $entry = $(el);
			const msgid = $entry.data("msgid");

			// Remove existing hints
			$entry.find(".reference-hints").remove();

			// Build table columns
			let headers = [];
			let cells = [];
			let copyButtons = [];

			// Add column for original text (English)
			headers.push(`<th class="ref-lang">EN</th>`);
			cells.push(`<td class="ref-text">${frappe.utils.escape_html(msgid)}</td>`);
			copyButtons.push(`
				<td class="ref-copy">
					<button class="btn btn-xs btn-default copy-ref-clipboard" data-text="${frappe.utils.escape_html(msgid)}" title="${__("Copy to clipboard")}">
						<svg class="icon icon-sm"><use href="#icon-copy"></use></svg>
					</button>
				</td>
			`);

			// Add columns for reference languages
			for (const [lang, translations] of Object.entries(this.reference_translations)) {
				if (translations[msgid]) {
					const translation = translations[msgid];
					headers.push(`<th class="ref-lang">${lang.toUpperCase()}</th>`);
					cells.push(`<td class="ref-text">${frappe.utils.escape_html(translation)}</td>`);
					copyButtons.push(`
						<td class="ref-copy">
							<button class="btn btn-xs btn-default copy-ref-clipboard" data-text="${frappe.utils.escape_html(translation)}" title="${__("Copy to clipboard")}">
								<svg class="icon icon-sm"><use href="#icon-copy"></use></svg>
							</button>
						</td>
					`);
				}
			}

			if (headers.length > 0) {
				const $hints = $(`
					<div class="reference-hints">
						<div class="hints-label">${__("Reference translations")}</div>
						<table class="table table-sm reference-table">
							<thead>
								<tr>${headers.join("")}</tr>
							</thead>
							<tbody>
								<tr>${cells.join("")}</tr>
								<tr>${copyButtons.join("")}</tr>
							</tbody>
						</table>
					</div>
				`);
				$entry.find(".entry-translation").append($hints);

				// Bind copy to clipboard buttons
				$hints.find(".copy-ref-clipboard").on("click", (e) => {
					e.preventDefault();
					const text = $(e.currentTarget).data("text");

					// Copy to clipboard
					navigator.clipboard.writeText(text).then(() => {
						frappe.show_alert({
							message: __("Copied to clipboard"),
							indicator: "green"
						});
					}).catch(() => {
						// Fallback for older browsers
						const textarea = document.createElement('textarea');
						textarea.value = text;
						document.body.appendChild(textarea);
						textarea.select();
						document.execCommand('copy');
						document.body.removeChild(textarea);
						frappe.show_alert({
							message: __("Copied to clipboard"),
							indicator: "green"
						});
					});
				});
			}
		});
	}
}
