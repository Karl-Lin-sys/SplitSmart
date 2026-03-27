import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import { Upload, Receipt as ReceiptIcon, Send, Loader2, User, DollarSign, Image as ImageIcon } from 'lucide-react';

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface ReceiptItem {
  id: string;
  name: string;
  price: number;
  persons: string[];
}

interface Receipt {
  items: ReceiptItem[];
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
}

interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export default function App() {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory]);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsParsing(true);
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Data = reader.result as string;
        setImagePreview(base64Data);
        
        const base64String = base64Data.split(',')[1];
        const mimeType = file.type;

        const response = await ai.models.generateContent({
          model: "gemini-3.1-pro-preview",
          contents: [
            {
              inlineData: {
                data: base64String,
                mimeType: mimeType,
              }
            },
            "Parse this receipt and extract the items, subtotal, tax, tip, and total. Assign a unique string ID to each item. If tip is not explicitly mentioned, set it to 0. Ensure the math adds up. Return ONLY valid JSON."
          ],
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                items: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING },
                      name: { type: Type.STRING },
                      price: { type: Type.NUMBER },
                    },
                    required: ["id", "name", "price"]
                  }
                },
                subtotal: { type: Type.NUMBER },
                tax: { type: Type.NUMBER },
                tip: { type: Type.NUMBER },
                total: { type: Type.NUMBER },
              },
              required: ["items", "subtotal", "tax", "tip", "total"]
            }
          }
        });

        const parsed = JSON.parse(response.text || "{}");
        // Initialize persons array for each item
        const itemsWithPersons = (parsed.items || []).map((item: any) => ({
          ...item,
          persons: []
        }));
        
        setReceipt({
          ...parsed,
          items: itemsWithPersons
        });
        
        setChatHistory([
          { role: 'model', text: "I've parsed the receipt! Who had what? You can say things like 'Dhruv had the nachos' or 'Sarah and Sue shared the pizza'." }
        ]);
      };
      reader.readAsDataURL(file);
    } catch (error) {
      console.error("Error parsing receipt:", error);
      alert("Failed to parse receipt. Please try again.");
    } finally {
      setIsParsing(false);
    }
  };

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || !receipt) return;

    const userMsg = inputMessage.trim();
    setInputMessage('');
    setChatHistory(prev => [...prev, { role: 'user', text: userMsg }]);
    setIsChatting(true);

    try {
      const systemInstruction = `
You are a helpful assistant that helps users split a bill.
Update the assignments based on the user's message.
If multiple people share an item, add all their names to the 'persons' array for that item.
Reply to the user confirming what you did.

Here is the CURRENT state of the receipt items:
${JSON.stringify(receipt.items, null, 2)}

You must return a JSON object with 'reply' (your message to the user) and 'updatedAssignments' (the COMPLETE list of all items with their assigned persons, including unchanged items).
      `;

      // Build contents array
      const contents = chatHistory.map(msg => ({
        role: msg.role,
        parts: [{ text: msg.text }]
      }));
      contents.push({ role: 'user', parts: [{ text: userMsg }] });

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              reply: { type: Type.STRING },
              updatedAssignments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    itemId: { type: Type.STRING },
                    persons: { type: Type.ARRAY, items: { type: Type.STRING } }
                  },
                  required: ["itemId", "persons"]
                }
              }
            },
            required: ["reply", "updatedAssignments"]
          }
        }
      });

      const result = JSON.parse(response.text || "{}");
      
      // Update receipt state
      const newItems = receipt.items.map(item => {
        const assignment = result.updatedAssignments?.find((a: any) => a.itemId === item.id);
        return assignment ? { ...item, persons: assignment.persons } : item;
      });

      setReceipt({ ...receipt, items: newItems });
      setChatHistory(prev => [...prev, { role: 'model', text: result.reply || "Done." }]);

    } catch (error) {
      console.error("Error in chat:", error);
      setChatHistory(prev => [...prev, { role: 'model', text: "Sorry, I encountered an error processing that. Could you try again?" }]);
    } finally {
      setIsChatting(false);
    }
  };

  // Calculate summary
  const personTotals: Record<string, { subtotal: number, tax: number, tip: number, total: number }> = {};
  
  if (receipt) {
    receipt.items.forEach(item => {
      if (item.persons.length > 0) {
        const splitPrice = item.price / item.persons.length;
        item.persons.forEach(person => {
          if (!personTotals[person]) {
            personTotals[person] = { subtotal: 0, tax: 0, tip: 0, total: 0 };
          }
          personTotals[person].subtotal += splitPrice;
        });
      }
    });

    Object.keys(personTotals).forEach(person => {
      const p = personTotals[person];
      // Distribute tax and tip proportionally based on their share of the total receipt subtotal
      const ratio = receipt.subtotal > 0 ? p.subtotal / receipt.subtotal : 0;
      p.tax = receipt.tax * ratio;
      p.tip = receipt.tip * ratio;
      p.total = p.subtotal + p.tax + p.tip;
    });
  }

  return (
    <div className="min-h-screen bg-neutral-50 flex flex-col md:flex-row font-sans text-neutral-900">
      {/* Left Pane: Receipt & Summary */}
      <div className="w-full md:w-1/2 h-[50vh] md:h-screen border-b md:border-b-0 md:border-r border-neutral-200 bg-white flex flex-col overflow-hidden">
        <div className="p-6 border-b border-neutral-100 bg-white z-10 shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <ReceiptIcon className="w-6 h-6 text-indigo-600" />
            SplitSmart
          </h1>
          <p className="text-sm text-neutral-500 mt-1">Upload a receipt and chat to split the bill.</p>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {!receipt ? (
            <div className="h-full flex flex-col items-center justify-center border-2 border-dashed border-neutral-300 rounded-2xl bg-neutral-50 p-8 text-center transition-colors hover:bg-neutral-100">
              {isParsing ? (
                <div className="flex flex-col items-center gap-4">
                  <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
                  <p className="text-neutral-600 font-medium">Analyzing receipt...</p>
                </div>
              ) : (
                <>
                  <div className="w-16 h-16 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center mb-4">
                    <Upload className="w-8 h-8" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">Upload Receipt</h3>
                  <p className="text-neutral-500 text-sm mb-6 max-w-xs">
                    Take a photo or upload an image of your receipt to get started.
                  </p>
                  <label className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-medium cursor-pointer transition-colors shadow-sm">
                    Choose Image
                    <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                  </label>
                </>
              )}
            </div>
          ) : (
            <>
              {/* Receipt Details */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <ReceiptIcon className="w-5 h-5 text-neutral-400" />
                    Receipt Items
                  </h2>
                  {imagePreview && (
                    <button 
                      onClick={() => {
                        const w = window.open('');
                        w?.document.write(`<img src="${imagePreview}" style="max-width:100%;"/>`);
                      }}
                      className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center gap-1 bg-indigo-50 px-2 py-1 rounded-md"
                    >
                      <ImageIcon className="w-3 h-3" /> View Original
                    </button>
                  )}
                </div>
                
                <div className="bg-white border border-neutral-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="divide-y divide-neutral-100">
                    {receipt.items.map(item => (
                      <div key={item.id} className="p-4 hover:bg-neutral-50 transition-colors">
                        <div className="flex justify-between items-start mb-2">
                          <span className="font-medium text-neutral-800">{item.name}</span>
                          <span className="font-mono text-neutral-900">${item.price.toFixed(2)}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {item.persons.length > 0 ? (
                            item.persons.map((p, i) => (
                              <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                                <User className="w-3 h-3" />
                                {p}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-neutral-400 italic">Unassigned</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="bg-neutral-50 p-4 border-t border-neutral-200 space-y-2 text-sm">
                    <div className="flex justify-between text-neutral-600">
                      <span>Subtotal</span>
                      <span className="font-mono">${receipt.subtotal.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-neutral-600">
                      <span>Tax</span>
                      <span className="font-mono">${receipt.tax.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-neutral-600">
                      <span>Tip</span>
                      <span className="font-mono">${receipt.tip.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between font-semibold text-neutral-900 pt-2 border-t border-neutral-200">
                      <span>Total</span>
                      <span className="font-mono">${receipt.total.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Summary */}
              {Object.keys(personTotals).length > 0 && (
                <div className="space-y-4 pb-8">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <DollarSign className="w-5 h-5 text-neutral-400" />
                    Who Owes What
                  </h2>
                  <div className="grid gap-4">
                    {Object.entries(personTotals).map(([person, totals]) => (
                      <div key={person} className="bg-white border border-neutral-200 p-4 rounded-2xl shadow-sm flex justify-between items-center">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold shadow-inner">
                            {person.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-semibold text-neutral-900">{person}</div>
                            <div className="text-xs text-neutral-500">
                              Sub: ${totals.subtotal.toFixed(2)} • Tax: ${totals.tax.toFixed(2)} • Tip: ${totals.tip.toFixed(2)}
                            </div>
                          </div>
                        </div>
                        <div className="text-xl font-mono font-bold text-neutral-900">
                          ${totals.total.toFixed(2)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right Pane: Chat */}
      <div className="w-full md:w-1/2 h-[50vh] md:h-screen flex flex-col bg-neutral-50 relative">
        {!receipt && (
          <div className="absolute inset-0 z-20 bg-neutral-50/80 backdrop-blur-sm flex items-center justify-center p-6 text-center">
            <div className="bg-white p-6 rounded-2xl shadow-xl border border-neutral-200 max-w-sm">
              <div className="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center mx-auto mb-4">
                <ReceiptIcon className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-semibold mb-2">Upload a receipt first</h3>
              <p className="text-neutral-500 text-sm">
                Once you upload a receipt, you can chat with me to assign items to people.
              </p>
            </div>
          </div>
        )}

        <div className="p-4 border-b border-neutral-200 bg-white shadow-sm z-10">
          <h2 className="font-semibold text-neutral-800">Split Assistant</h2>
          <p className="text-xs text-neutral-500">Powered by Gemini</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {chatHistory.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div 
                className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                  msg.role === 'user' 
                    ? 'bg-indigo-600 text-white rounded-br-sm shadow-md' 
                    : 'bg-white border border-neutral-200 text-neutral-800 rounded-bl-sm shadow-sm'
                }`}
              >
                <p className="text-sm leading-relaxed">{msg.text}</p>
              </div>
            </div>
          ))}
          {isChatting && (
            <div className="flex justify-start">
              <div className="bg-white border border-neutral-200 rounded-2xl rounded-bl-sm px-4 py-4 shadow-sm flex items-center gap-2">
                <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="p-4 bg-white border-t border-neutral-200">
          <form 
            onSubmit={(e) => { e.preventDefault(); handleSendMessage(); }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              placeholder="e.g., Dhruv had the nachos..."
              disabled={!receipt || isChatting}
              className="flex-1 bg-neutral-100 border-transparent focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 rounded-xl px-4 py-3 text-sm transition-all disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!receipt || isChatting || !inputMessage.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-neutral-300 disabled:cursor-not-allowed text-white rounded-xl p-3 flex items-center justify-center transition-colors shadow-sm"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
