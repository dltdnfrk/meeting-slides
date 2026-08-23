import ApplicationServices
import Foundation

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil }
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }
func text(_ e: AXUIElement, _ name: String) -> String? { attr(e, name) as? String }
func findButton(_ e: AXUIElement, title: String) -> AXUIElement? { if text(e,kAXRoleAttribute as String)==kAXButtonRole as String && text(e,kAXTitleAttribute as String)==title { return e }; for c in children(e) { if let b=findButton(c,title:title){return b} }; return nil }
let args=CommandLine.arguments; guard args.count==3,let pid=Int32(args[1]) else { exit(2) }; let out=args[2]
guard AXIsProcessTrusted() else { try! "AX denied\n".write(toFile:out,atomically:true,encoding:.utf8); exit(3) }
let app=AXUIElementCreateApplication(pid); var payload:[String:Any]=["pid":Int(pid),"observerSubscribedBeforeTrigger":true]; var done=false
let callback: AXObserverCallback = { _, element, notification, refcon in
 let box=Unmanaged<NSMutableDictionary>.fromOpaque(refcon!).takeUnretainedValue(); box["notification"]=notification as String; box["windowTitle"]=text(element,kAXTitleAttribute as String) ?? NSNull();
 if let button=findButton(element,title:"계속 녹음") { box["continueButtonFound"]=true; box["pressStatus"]=AXUIElementPerformAction(button,kAXPressAction as CFString).rawValue } else { box["continueButtonFound"]=false }
 box["done"]=true; CFRunLoopStop(CFRunLoopGetCurrent())
}
let box=NSMutableDictionary(dictionary:payload); var observer:AXObserver?; let created=AXObserverCreate(pid,callback,&observer); guard created == .success,let observer else { exit(4) }
let add=AXObserverAddNotification(observer,app,kAXWindowCreatedNotification as CFString,Unmanaged.passUnretained(box).toOpaque()); box["observerCreateStatus"]=created.rawValue; box["observerAddStatus"]=add.rawValue
CFRunLoopAddSource(CFRunLoopGetCurrent(),AXObserverGetRunLoopSource(observer),.defaultMode)
// Make the installed NSApplication the real keyboard owner before posting Cmd-Q.
let frontmost = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue); box["frontmostSetStatus"] = frontmost.rawValue
let source = CGEventSource(stateID: .hidSystemState); let down = CGEvent(keyboardEventSource: source, virtualKey: 12, keyDown: true)!; let up = CGEvent(keyboardEventSource: source, virtualKey: 12, keyDown: false)!; down.flags = .maskCommand; up.flags = .maskCommand; down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap); box["commandQTriggeredAfterSubscription"] = true
Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { _ in box["timeoutFired"] = true; CFRunLoopStop(CFRunLoopGetCurrent()) }
CFRunLoopRun()
box["timedOut"]=(box["done"] as? Bool != true); let data=try! JSONSerialization.data(withJSONObject:box,options:[.prettyPrinted,.sortedKeys]); try! data.write(to:URL(fileURLWithPath:out)); if box["done"] as? Bool != true { exit(5) }
