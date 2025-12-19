import React, { useRef } from 'react';
import { useAppStore, ImageItem } from '../../store/useAppStore';
import { Reorder } from 'framer-motion';
import { Upload, GripVertical, Image as ImageIcon } from 'lucide-react';

export const ImageUploader: React.FC = () => {
  const { images, addImage, reorderImages, parts, selectedImageId, selectImage } = useAppStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      Array.from(e.target.files).forEach(file => {
        addImage(file);
      });
    }
  };

  const handleReorder = (newOrder: ImageItem[]) => {
     reorderImages(newOrder);
  };

  return (
    <div className="flex flex-col gap-4">
       <div 
        onClick={() => fileInputRef.current?.click()}
        className="
          border-2 border-dashed border-[rgba(255,255,255,0.2)] 
          rounded-lg p-6 flex flex-col items-center justify-center gap-2
          cursor-pointer hover:border-[var(--accent-color)] hover:bg-[rgba(255,255,255,0.05)]
          transition-all
        "
      >
        <Upload className="w-6 h-6 text-[var(--accent-color)]" />
        <span className="text-sm font-medium">Upload Images</span>
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          accept="image/*" 
          multiple
          onChange={handleFileChange}
        />
      </div>

      {/* Debug Button */}
      <button 
        onClick={() => {
           // Mock file for testing
           const file = new File(["foo"], "Debug_Image.png", { type: "image/png" });
           addImage(file);
        }}
        className="text-[10px] text-gray-500 hover:text-white underline self-center"
      >
         DEBUG: Add Test Image
      </button>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs uppercase text-[var(--text-secondary)] font-bold tracking-wider">Sequence</h3>
        <Reorder.Group axis="y" values={images} onReorder={handleReorder} className="flex flex-col gap-2">
          {images.map((img) => {
            const isSelected = img.id === selectedImageId;
            return (
              <Reorder.Item key={img.id} value={img} onClick={() => selectImage(img.id)}>
                <div className={`
                  border rounded p-2 flex items-center gap-3 select-none cursor-pointer transition-colors
                  ${isSelected 
                     ? 'bg-[var(--accent-color)]/20 border-[var(--accent-color)]' 
                     : 'bg-[rgba(0,0,0,0.4)] border-[rgba(255,255,255,0.1)] hover:border-[rgba(255,255,255,0.3)]'}
                `}>
                  <GripVertical className="w-4 h-4 text-[var(--text-secondary)] cursor-grab active:cursor-grabbing" />
                  <div className="w-10 h-10 rounded overflow-hidden bg-black/50 shrink-0">
                    <img src={img.url} alt={img.name} className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate" title={img.name}>{img.name}</div>
                     <div className="flex items-center gap-1 mt-1">
                       <span className={`text-[10px] truncate ${isSelected ? 'text-white' : 'text-[var(--text-secondary)]'}`}>
                          {Object.keys(img.partPositions).length > 0 
                            ? `Detected: ${Object.keys(img.partPositions).length} parts` 
                            : 'Analyzing...'}
                       </span>
                    </div>
                  </div>
                </div>
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
        {images.length === 0 && (
          <div className="text-center text-xs opacity-40 py-4">No images uploaded</div>
        )}
      </div>
    </div>
  );
};
