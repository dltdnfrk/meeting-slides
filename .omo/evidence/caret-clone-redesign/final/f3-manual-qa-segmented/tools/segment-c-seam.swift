import Foundation

let phases: [CapturePhase] = [.idle,.starting,.capturing,.stopping,.switchingModel]
let protection = Dictionary(uniqueKeysWithValues: phases.map { ($0.rawValue,$0.requiresQuitProtection) })
var owned = ServerLifecycle(ownsServer:true)
let ownedFirst = owned.handle(.quit).map(String.init(describing:))
let ownedSecond = owned.handle(.interrupt).map(String.init(describing:))
var adopted = ServerLifecycle(ownsServer:false)
let adoptedFirst = adopted.handle(.quit).map(String.init(describing:))
let adoptedSecond = adopted.handle(.interrupt).map(String.init(describing:))
let payload: [String:Any] = [
 "quitProtection": protection,
 "ownedServer": ["firstEffects":ownedFirst,"secondEffects":ownedSecond,"terminationRequests":owned.terminationRequests,"state":owned.state.rawValue],
 "adoptedServer": ["firstEffects":adoptedFirst,"secondEffects":adoptedSecond,"terminationRequests":adopted.terminationRequests,"state":adopted.state.rawValue]
]
let data=try! JSONSerialization.data(withJSONObject:payload,options:[.prettyPrinted,.sortedKeys]);FileHandle.standardOutput.write(data);FileHandle.standardOutput.write("\n".data(using:.utf8)!)
