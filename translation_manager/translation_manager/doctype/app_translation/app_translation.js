// Copyright (c) 2024, Maxim S and contributors
// For license information, please see license.txt

frappe.ui.form.on("App Translation", {
	refresh(frm) {
		if (!frm.is_new()) {
			frm.add_custom_button(__("Open Translation Editor"), function() {
				frappe.set_route("translation-editor");
				// Set query parameters after route change
				setTimeout(() => {
					if (frappe.cur_page && frappe.cur_page.page && frappe.cur_page.page.translation_editor) {
						frappe.cur_page.page.translation_editor.app_field.set_value(frm.doc.app_name);
						frappe.cur_page.page.translation_editor.language_field.set_value(frm.doc.language);
						frappe.cur_page.page.translation_editor.load_translations();
					}
				}, 100);
			});

			frm.add_custom_button(__("Generate POT"), function() {
				frappe.call({
					method: "translation_manager.api.generate_pot",
					args: { app: frm.doc.app_name },
					freeze: true,
					freeze_message: __("Generating POT file..."),
					callback: function(r) {
						if (r.message && r.message.success) {
							frappe.msgprint(__("POT file generated successfully"));
							frm.reload_doc();
						}
					}
				});
			}, __("Actions"));

			frm.add_custom_button(__("Export PO"), function() {
				frappe.call({
					method: "translation_manager.api.export_po",
					args: {
						app: frm.doc.app_name,
						language: frm.doc.language
					},
					callback: function(r) {
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
			}, __("Actions"));

			frm.add_custom_button(__("Import PO"), function() {
				new frappe.ui.FileUploader({
					as_dataurl: true,
					allow_multiple: false,
					on_success(file) {
						const content = atob(file.dataurl.split(",")[1]);
						frappe.call({
							method: "translation_manager.api.import_po",
							args: {
								app: frm.doc.app_name,
								language: frm.doc.language,
								content: content
							},
							freeze: true,
							freeze_message: __("Importing PO file..."),
							callback: function(r) {
								if (r.message && r.message.success) {
									frappe.msgprint(__("PO file imported successfully"));
									frm.reload_doc();
								}
							}
						});
					}
				});
			}, __("Actions"));

			frm.add_custom_button(__("Compile MO"), function() {
				frappe.call({
					method: "translation_manager.api.compile_mo",
					args: {
						app: frm.doc.app_name,
						language: frm.doc.language
					},
					freeze: true,
					freeze_message: __("Compiling MO file..."),
					callback: function(r) {
						if (r.message && r.message.success) {
							frappe.msgprint(__("MO file compiled successfully"));
						}
					}
				});
			}, __("Actions"));

			// Show progress bar
			if (frm.doc.total_strings > 0) {
				const progress_html = `
					<div class="progress" style="height: 20px; margin-top: 10px;">
						<div class="progress-bar" role="progressbar"
							style="width: ${frm.doc.progress}%;"
							aria-valuenow="${frm.doc.progress}"
							aria-valuemin="0" aria-valuemax="100">
							${frm.doc.progress}%
						</div>
					</div>
					<p class="text-muted" style="margin-top: 5px;">
						${frm.doc.translated_strings} / ${frm.doc.total_strings} ${__("strings translated")}
					</p>
				`;
				frm.set_intro(progress_html);
			}
		}
	}
});
