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

		frappe.call({
			method: "translation_manager.api.get_po_entries",
			args: { app: app, language: language },
			freeze: true,
			freeze_message: __("Loading translations..."),
			callback: (r) => {
				if (r.message) {
					this.entries = r.message;
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
		const translated = this.entries.filter(e => e.msgstr).length;
		const fuzzy = this.entries.filter(e => e.fuzzy).length;
		const progress = total ? Math.round(translated / total * 100) : 0;

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
		`);
	}

	filter_entries() {
		let filtered = [...this.entries];
		const search = (this.search_field.get_value() || "").toLowerCase().trim();

		// Apply search filter
		if (search) {
			filtered = filtered.filter(e => {
				const msgid_lower = e.msgid.toLowerCase();
				const msgstr_lower = (e.msgstr || "").toLowerCase();
				return msgid_lower.includes(search) || msgstr_lower.includes(search);
			});

			// Sort by relevance: exact matches first, then starts with, then contains
			filtered.sort((a, b) => {
				const a_msgid = a.msgid.toLowerCase();
				const b_msgid = b.msgid.toLowerCase();
				const a_msgstr = (a.msgstr || "").toLowerCase();
				const b_msgstr = (b.msgstr || "").toLowerCase();

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
			filtered = filtered.filter(e => !e.msgstr);
		} else if (this.filter_mode === "fuzzy") {
			filtered = filtered.filter(e => e.fuzzy);
		}

		this.filtered_entries = filtered;
		this.current_page = 0;
		this.render_entries();
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
			const status_class = !entry.msgstr ? "untranslated" : (entry.fuzzy ? "fuzzy" : "translated");

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

			html += `
				<div class="translation-entry ${modified_class} ${status_class}" data-msgid="${frappe.utils.escape_html(entry.msgid)}">
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
					</div>
					<div class="entry-translation">
						<div class="entry-label">${__("Translation")}</div>
						<textarea class="form-control translation-input" rows="2">${frappe.utils.escape_html(entry.msgstr || "")}</textarea>
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

		// Bind events
		this.container.find(".translation-input").on("input", (e) => {
			const $entry = $(e.target).closest(".translation-entry");
			const msgid = $entry.data("msgid");
			const msgstr = e.target.value;
			const fuzzy = $entry.find(".fuzzy-input").prop("checked");

			this.modified[msgid] = { msgstr, fuzzy };
			$entry.addClass("modified");
		});

		this.container.find(".fuzzy-input").on("change", (e) => {
			const $entry = $(e.target).closest(".translation-entry");
			const msgid = $entry.data("msgid");
			const msgstr = $entry.find(".translation-input").val();
			const fuzzy = e.target.checked;

			this.modified[msgid] = { msgstr, fuzzy };
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

		// Render pagination
		this.render_pagination();

		// Load reference translations for current page
		this.load_reference_translations();
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
			fuzzy: data.fuzzy
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
