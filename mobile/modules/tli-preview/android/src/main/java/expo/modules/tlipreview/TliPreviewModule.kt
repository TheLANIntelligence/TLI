package expo.modules.tlipreview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TliPreviewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TliPreview")
    View(TliPreviewView::class) {
      Events("onCheckResult")
      Prop("html") { view: TliPreviewView, value: String -> view.html = value }
      Prop("headers") { view: TliPreviewView, value: Map<String, String> -> view.headers = value }
      Prop("token") { view: TliPreviewView, value: String -> view.token = value }
      Prop("revisionKey") { view: TliPreviewView, value: String -> view.revisionKey = value }
      OnViewDidUpdateProps { view: TliPreviewView -> view.render() }
      OnViewDestroys { view: TliPreviewView -> view.dispose() }
    }
  }
}
