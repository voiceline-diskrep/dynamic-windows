"""
One-Shot Preset Management & Application Picker UI
Provides preset tiles, preset editor, installed app search, and one-click launch controls.
"""

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QLineEdit, QListWidget, QListWidgetItem, QDialog, QMessageBox,
    QFrame, QScrollArea, QGridLayout, QComboBox, QSpinBox
)

from oneshot.discovery import AppDiscoveryEngine, DiscoveredApp
from oneshot.presets import PresetManager, Preset
from oneshot.launcher import AppLaunchEngine


class AppPickerDialog(QDialog):
    """Dialog to pick from discovered installed applications or browse custom exe."""
    def __init__(self, discovery_engine: AppDiscoveryEngine, parent=None):
        super().__init__(parent)
        self.discovery_engine = discovery_engine
        self.selected_app: DiscoveredApp = None

        self.setWindowTitle("Select Application")
        self.resize(480, 520)
        self.setStyleSheet("""
            QDialog {
                background-color: #121215;
                color: #e4e4e7;
                border: 1px solid #27272a;
                border-radius: 12px;
                font-family: 'Segoe UI', sans-serif;
            }
            QLineEdit {
                background-color: #18181b;
                color: #ffffff;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                padding: 8px 12px;
                font-size: 13px;
            }
            QListWidget {
                background-color: #18181b;
                border: 1px solid #27272a;
                border-radius: 8px;
                padding: 4px;
            }
            QListWidget::item {
                padding: 8px 12px;
                border-radius: 6px;
                color: #f4f4f5;
            }
            QListWidget::item:selected {
                background-color: #2563eb;
                color: #ffffff;
            }
            QPushButton {
                background-color: #27272a;
                color: #ffffff;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                padding: 6px 14px;
            }
            QPushButton:hover {
                background-color: #3b82f6;
            }
        """)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 18, 18, 18)
        layout.setSpacing(12)

        header = QLabel("Add Application to Preset")
        header.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        layout.addWidget(header)

        # Search Bar
        self.txt_search = QLineEdit()
        self.txt_search.setPlaceholderText("Search installed applications...")
        self.txt_search.textChanged.connect(self.filter_apps)
        layout.addWidget(self.txt_search)

        # Apps List
        self.app_list = QListWidget()
        self.app_list.itemDoubleClicked.connect(self.on_item_double_clicked)
        layout.addWidget(self.app_list)

        # Action Buttons
        btn_bar = QHBoxLayout()
        btn_browse = QPushButton("Browse .exe...")
        btn_browse.clicked.connect(self.browse_custom)
        btn_bar.addWidget(btn_browse)

        btn_bar.addStretch()

        btn_add = QPushButton("Add Selected")
        btn_add.setStyleSheet("background-color: #2563eb; font-weight: 600;")
        btn_add.clicked.connect(self.accept_selection)
        btn_bar.addWidget(btn_add)

        btn_cancel = QPushButton("Cancel")
        btn_cancel.clicked.connect(self.reject)
        btn_bar.addWidget(btn_cancel)

        layout.addLayout(btn_bar)

        self.all_apps = self.discovery_engine.discover_applications()
        self.populate_list(self.all_apps)

    def populate_list(self, apps):
        self.app_list.clear()
        for app in apps:
            item = QListWidgetItem(f"{app.name} ({'System' if app.source == 'system' else 'Installed'})")
            item.setIcon(self.discovery_engine.get_app_icon(app.executable_path))
            item.setData(Qt.ItemDataRole.UserRole, app)
            self.app_list.addItem(item)

    def filter_apps(self, query):
        q = query.lower().strip()
        filtered = [a for a in self.all_apps if q in a.name.lower() or q in a.executable_path.lower()]
        self.populate_list(filtered)

    def on_item_double_clicked(self, item):
        self.selected_app = item.data(Qt.ItemDataRole.UserRole)
        self.accept()

    def accept_selection(self):
        item = self.app_list.currentItem()
        if item:
            self.selected_app = item.data(Qt.ItemDataRole.UserRole)
            self.accept()
        else:
            QMessageBox.information(self, "Select Application", "Please select an application from the list.")

    def browse_custom(self):
        custom = self.discovery_engine.browse_for_custom_executable(self)
        if custom:
            self.selected_app = custom
            self.accept()


class PresetEditorDialog(QDialog):
    """Dialog to create or edit a preset."""
    def __init__(self, preset: Preset, discovery_engine: AppDiscoveryEngine, parent=None):
        super().__init__(parent)
        self.preset = preset
        self.discovery_engine = discovery_engine
        self.current_apps = list(preset.apps)

        self.setWindowTitle(f"Edit Preset: {preset.name}")
        self.resize(520, 560)
        self.setStyleSheet("""
            QDialog {
                background-color: #121215;
                color: #e4e4e7;
                border: 1px solid #27272a;
                border-radius: 12px;
                font-family: 'Segoe UI', sans-serif;
            }
            QLineEdit, QComboBox, QSpinBox {
                background-color: #18181b;
                color: #ffffff;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                padding: 6px 10px;
                font-size: 13px;
            }
            QListWidget {
                background-color: #18181b;
                border: 1px solid #27272a;
                border-radius: 8px;
                padding: 4px;
            }
            QListWidget::item {
                padding: 6px 10px;
                border-radius: 4px;
                color: #f4f4f5;
            }
            QListWidget::item:selected {
                background-color: #27272a;
                color: #38bdf8;
            }
            QPushButton {
                background-color: #1f1f24;
                color: #ffffff;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                padding: 6px 14px;
            }
            QPushButton:hover {
                background-color: #27272a;
            }
        """)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(12)

        header = QLabel("Preset Configuration")
        header.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        layout.addWidget(header)

        # Name
        name_row = QHBoxLayout()
        name_row.addWidget(QLabel("Name:"))
        self.txt_name = QLineEdit(preset.name)
        name_row.addWidget(self.txt_name)
        layout.addLayout(name_row)

        # Description
        desc_row = QHBoxLayout()
        desc_row.addWidget(QLabel("Description:"))
        self.txt_desc = QLineEdit(preset.description)
        desc_row.addWidget(self.txt_desc)
        layout.addLayout(desc_row)

        # Apps List
        lbl_apps = QLabel("Applications in this Preset:")
        lbl_apps.setStyleSheet("font-size: 13px; font-weight: 600; color: #a1a1aa; margin-top: 6px;")
        layout.addWidget(lbl_apps)

        self.list_widget = QListWidget()
        self.populate_apps_list()
        layout.addWidget(self.list_widget)

        # App Actions (Add, Remove, Move Up, Move Down)
        app_btn_row = QHBoxLayout()
        btn_add = QPushButton("➕ Add App...")
        btn_add.clicked.connect(self.add_app)
        app_btn_row.addWidget(btn_add)

        btn_remove = QPushButton("🗑 Remove")
        btn_remove.clicked.connect(self.remove_app)
        app_btn_row.addWidget(btn_remove)

        btn_up = QPushButton("▲ Up")
        btn_up.clicked.connect(lambda: self.move_item(-1))
        app_btn_row.addWidget(btn_up)

        btn_down = QPushButton("▼ Down")
        btn_down.clicked.connect(lambda: self.move_item(1))
        app_btn_row.addWidget(btn_down)
        layout.addLayout(app_btn_row)

        # Save & Cancel
        bottom_row = QHBoxLayout()
        bottom_row.addStretch()

        btn_save = QPushButton("Save Preset")
        btn_save.setStyleSheet("background-color: #2563eb; font-weight: 600;")
        btn_save.clicked.connect(self.save)
        bottom_row.addWidget(btn_save)

        btn_cancel = QPushButton("Cancel")
        btn_cancel.clicked.connect(self.reject)
        bottom_row.addWidget(btn_cancel)
        layout.addLayout(bottom_row)

    def populate_apps_list(self):
        self.list_widget.clear()
        for app in self.current_apps:
            item = QListWidgetItem(f"{app.name}  —  {app.executable_path}")
            item.setIcon(self.discovery_engine.get_app_icon(app.executable_path))
            self.list_widget.addItem(item)

    def add_app(self):
        picker = AppPickerDialog(self.discovery_engine, self)
        if picker.exec() and picker.selected_app:
            self.current_apps.append(picker.selected_app)
            self.populate_apps_list()

    def remove_app(self):
        row = self.list_widget.currentRow()
        if 0 <= row < len(self.current_apps):
            del self.current_apps[row]
            self.populate_apps_list()

    def move_item(self, direction):
        row = self.list_widget.currentRow()
        new_row = row + direction
        if 0 <= row < len(self.current_apps) and 0 <= new_row < len(self.current_apps):
            self.current_apps[row], self.current_apps[new_row] = self.current_apps[new_row], self.current_apps[row]
            self.populate_apps_list()
            self.list_widget.setCurrentRow(new_row)

    def save(self):
        name = self.txt_name.text().strip()
        if not name:
            QMessageBox.warning(self, "Invalid Name", "Preset name cannot be empty.")
            return
        self.preset.name = name
        self.preset.description = self.txt_desc.text().strip()
        self.preset.apps = self.current_apps
        self.accept()


class OneShotWidget(QWidget):
    """Main One-Shot view designed for the Dynamic Island expanded panel."""
    launch_requested = pyqtSignal(object)  # Emits Preset

    def __init__(self, preset_manager: PresetManager, launch_engine: AppLaunchEngine, discovery_engine: AppDiscoveryEngine, parent=None):
        super().__init__(parent)
        self.preset_manager = preset_manager
        self.launch_engine = launch_engine
        self.discovery_engine = discovery_engine

        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 14, 14, 14)
        layout.setSpacing(12)

        # Header Bar
        top_row = QHBoxLayout()
        lbl_title = QLabel("⚡ One-Shot Launcher")
        lbl_title.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        top_row.addWidget(lbl_title)

        top_row.addStretch()

        btn_new = QPushButton("＋ New Preset")
        btn_new.setStyleSheet("""
            QPushButton {
                background-color: #2563eb;
                color: #ffffff;
                font-weight: 600;
                border-radius: 6px;
                padding: 4px 12px;
                font-size: 12px;
            }
            QPushButton:hover { background-color: #1d4ed8; }
        """)
        btn_new.clicked.connect(self.create_new_preset)
        top_row.addWidget(btn_new)
        layout.addLayout(top_row)

        # Presets Scroll Area
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet("background: transparent; border: none;")

        self.container = QWidget()
        self.container.setStyleSheet("background: transparent;")
        self.grid = QGridLayout(self.container)
        self.grid.setSpacing(12)
        self.grid.setContentsMargins(0, 0, 0, 0)

        scroll.setWidget(self.container)
        layout.addWidget(scroll)

        self.refresh_presets()

    def refresh_presets(self):
        # Clear grid
        while self.grid.count():
            item = self.grid.takeAt(0)
            widget = item.widget()
            if widget:
                widget.deleteLater()

        presets = self.preset_manager.get_presets()
        if not presets:
            lbl_empty = QLabel("No presets configured.\nClick '＋ New Preset' above to create your first workspace.")
            lbl_empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
            lbl_empty.setStyleSheet("color: #71717a; font-size: 13px; padding: 30px;")
            self.grid.addWidget(lbl_empty, 0, 0)
            return

        for idx, p in enumerate(presets):
            tile = self.create_tile(p)
            self.grid.addWidget(tile, idx // 2, idx % 2)

    def create_tile(self, preset: Preset) -> QFrame:
        tile = QFrame()
        tile.setStyleSheet("""
            QFrame {
                background-color: #18181c;
                border: 1px solid #27272a;
                border-radius: 10px;
                padding: 10px;
            }
            QFrame:hover {
                border-color: #3b82f6;
                background-color: #202026;
            }
        """)

        layout = QVBoxLayout(tile)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(6)

        # Name & Launch Button
        top = QHBoxLayout()
        name_lbl = QLabel(preset.name)
        name_lbl.setStyleSheet("font-size: 13px; font-weight: 600; color: #ffffff;")
        top.addWidget(name_lbl)
        top.addStretch()

        btn_launch = QPushButton("▶ Launch")
        btn_launch.setStyleSheet("""
            QPushButton {
                background-color: #2563eb;
                color: #ffffff;
                font-weight: 600;
                border-radius: 4px;
                padding: 3px 10px;
                font-size: 11px;
            }
            QPushButton:hover { background-color: #1d4ed8; }
        """)
        btn_launch.clicked.connect(lambda _, p=preset: self.launch_engine.launch_preset(p))
        top.addWidget(btn_launch)
        layout.addLayout(top)

        # Description
        desc_lbl = QLabel(preset.description or f"{len(preset.apps)} applications")
        desc_lbl.setStyleSheet("font-size: 11px; color: #a1a1aa;")
        layout.addWidget(desc_lbl)

        # Apps preview
        apps_txt = " • ".join([a.name for a in preset.apps[:3]]) or "Empty preset"
        if len(preset.apps) > 3:
            apps_txt += f" (+{len(preset.apps) - 3})"
        apps_lbl = QLabel(apps_txt)
        apps_lbl.setStyleSheet("font-size: 10px; color: #71717a;")
        layout.addWidget(apps_lbl)

        # Tile Actions (Edit, Duplicate, Delete)
        action_row = QHBoxLayout()
        action_row.addStretch()

        btn_edit = QPushButton("Edit")
        btn_edit.setStyleSheet("background: transparent; color: #38bdf8; font-size: 11px; border: none;")
        btn_edit.clicked.connect(lambda _, p=preset: self.edit_preset(p))
        action_row.addWidget(btn_edit)

        btn_dup = QPushButton("Duplicate")
        btn_dup.setStyleSheet("background: transparent; color: #a1a1aa; font-size: 11px; border: none;")
        btn_dup.clicked.connect(lambda _, p=preset: self.duplicate_preset(p))
        action_row.addWidget(btn_dup)

        btn_del = QPushButton("Delete")
        btn_del.setStyleSheet("background: transparent; color: #ef4444; font-size: 11px; border: none;")
        btn_del.clicked.connect(lambda _, p=preset: self.delete_preset(p))
        action_row.addWidget(btn_del)

        layout.addLayout(action_row)
        return tile

    def create_new_preset(self):
        new_p = Preset(id="", name="My Preset", description="", apps=[])
        dlg = PresetEditorDialog(new_p, self.discovery_engine, self)
        if dlg.exec():
            self.preset_manager.add_preset(new_p.name, new_p.description, new_p.icon, new_p.apps)
            self.refresh_presets()

    def edit_preset(self, preset: Preset):
        dlg = PresetEditorDialog(preset, self.discovery_engine, self)
        if dlg.exec():
            self.preset_manager.update_preset(preset.id, preset.name, preset.description, preset.icon, preset.apps)
            self.refresh_presets()

    def duplicate_preset(self, preset: Preset):
        self.preset_manager.duplicate_preset(preset.id)
        self.refresh_presets()

    def delete_preset(self, preset: Preset):
        if QMessageBox.question(self, "Delete Preset", f"Delete preset '{preset.name}'?") == QMessageBox.StandardButton.Yes:
            self.preset_manager.delete_preset(preset.id)
            self.refresh_presets()


class OneShotWindow(QDialog):
    """Spacious standalone window for the One-Shot application launcher."""
    def __init__(self, preset_manager: PresetManager, launch_engine: AppLaunchEngine, discovery_engine: AppDiscoveryEngine, parent=None):
        super().__init__(parent)
        self.setWindowTitle("One-Shot Application Launcher")
        self.resize(760, 560)
        self.setStyleSheet("""
            QDialog {
                background-color: #121215;
                color: #e4e4e7;
                border: 1px solid #27272a;
                border-radius: 12px;
                font-family: 'Segoe UI', sans-serif;
            }
        """)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        self.widget = OneShotWidget(preset_manager, launch_engine, discovery_engine, self)
        layout.addWidget(self.widget)
